import { ipcMain, app, dialog, BrowserWindow, desktopCapturer, safeStorage } from 'electron';
import { Logger } from '../logger';
import { autoLaunch } from './auto.launch';
import axios, { AxiosRequestConfig } from 'axios';
import { downloadFile, moveWindowToTop, unzip, zip } from '../utils';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { OCSApi, getValidBrowsers } from '@ocs-desktop/common';
import si from 'systeminformation';
import { store } from '../store';
import { exportExcel } from '../utils/index';
import { readdir, stat } from 'fs/promises';
import { updateApp } from './updater';
import { AutomationScripts } from '../scripts';
import { AutomationScript } from '../scripts/script';
import { getBrowserMajorVersion, getExtensionPaths } from '../utils/browser';
import { AppStore } from '../../types';
import { encryptRenderString, decryptRenderString } from '../crypto';
import { attachRendererWindow, getRemoteApiStatus, restartRemoteApi } from './remote.api';
import { clearApiKey, generateApiKey, setApiKey, updateRemoteApiConfig } from './remote.api/config';
import { regenerateTlsMaterial } from './remote.api/tls';
import {
	confirmHostKey,
	ensureKeyPair,
	getSshTunnelStatus,
	restartTunnel,
	scanHostKey,
	updateSshTunnelConfig
} from './ssh.tunnel';

export type RawAutomationScript = Pick<AutomationScript, 'configs' | 'name'>;

/**
 * 注册主进程远程通信事件
 * @param name 事件前缀名称
 * @param target 事件目标
 */
function registerRemoteEvent(name: string, target: any) {
	const logger = Logger('remote');
	try {
		ipcMain
			.on(name + '-get', (event, [property]) => {
				try {
					// logger.info({ event: name + '-get', args: [property] });
					event.returnValue = target[property];
				} catch (e) {
					event.returnValue = { error: e };
				}
			})
			.on(name + '-set', (event, [property, value]) => {
				try {
					// logger.info({ event: name + '-set', args: [property, value] });
					event.returnValue = target[property] = value;
				} catch (e) {
					event.returnValue = { error: e };
				}
			})

			/** 异步调用 */
			.on(
				name + '-call',
				async (
					event,
					[
						/** 回调id */
						respondChannel,
						property,
						...args
					]
				) => {
					// logger.info({ event: name + '-call', args });
					const safeReply = (payload: { data?: any; error?: any }) => {
						try {
							if (!event.sender.isDestroyed()) {
								event.sender.send(respondChannel, payload);
							}
						} catch {}
					};
					try {
						const result = await target[property](...args);
						safeReply({ data: result });
					} catch (e) {
						safeReply({ error: e });
					}
				}
			)

			/** 同步调用 */
			.on(name + '-call-sync', (event, [property, ...args]) => {
				// logger.info({ event: name + '-call-sync', args: [property] });
				try {
					const result = target[property](...args);
					event.returnValue = { data: result };
				} catch (e) {
					event.returnValue = { error: e };
				}
			});
	} catch (err) {
		logger.error(err);
	}
}

let win: BrowserWindow | undefined;

/**
 * 获取主窗口。
 *
 * 不要用 getCurrentWebContents()：bootstrap 里 startupServer() 与 createWindow()
 * 是并行的两个分支，服务器完全可能先于窗口就绪，此时
 * BrowserWindow.getAllWindows()[0] 是 undefined 会直接抛异常。
 */
export function getMainWindow(): BrowserWindow | undefined {
	return win;
}

const REMOTE_API_BIND_ADDRESSES = ['0.0.0.0', '127.0.0.1'];

/**
 * SSH 隧道配置里允许渲染进程修改的字段。
 *
 * host 与 user 会被拼进 ssh 的参数，所以做字符白名单校验。
 * 虽然用的是 spawn（参数数组、不经 shell），但形如 `-oProxyCommand=...`
 * 的值仍可能被 ssh 当成选项解析，白名单能把这类值挡住。
 */
const SSH_TUNNEL_ALLOWED_KEYS = ['enabled', 'host', 'port', 'user', 'sshPath', 'keyPath'];
// 主机名 / IPv4 / 不带方括号的 IPv6 都能过；刻意不放行方括号与等号，
// 避免 `-oProxyCommand=...` 这类值被 ssh 当成选项解析
const SSH_HOST_RE = /^[A-Za-z0-9._:]+$/;
const SSH_USER_RE = /^[A-Za-z0-9._-]+$/;

function sanitizeSshTunnelPatch(patch: any): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	if (!patch || typeof patch !== 'object') {
		return result;
	}

	for (const key of Object.keys(patch)) {
		if (!SSH_TUNNEL_ALLOWED_KEYS.includes(key)) {
			throw new Error(`不支持的字段: ${key}`);
		}
	}

	if ('enabled' in patch) {
		result.enabled = Boolean(patch.enabled);
	}
	if ('host' in patch) {
		const host = String(patch.host ?? '').trim();
		if (host && (!SSH_HOST_RE.test(host) || host.startsWith('-'))) {
			throw new Error('主机地址含有非法字符');
		}
		result.host = host;
	}
	if ('port' in patch) {
		const port = Number(patch.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error('SSH 端口必须是 1-65535 之间的整数');
		}
		result.port = port;
	}
	if ('user' in patch) {
		const user = String(patch.user ?? '').trim();
		if (user && (!SSH_USER_RE.test(user) || user.startsWith('-'))) {
			throw new Error('用户名含有非法字符');
		}
		result.user = user;
	}
	if ('sshPath' in patch) {
		result.sshPath = String(patch.sshPath ?? '').trim();
	}
	if ('keyPath' in patch) {
		result.keyPath = String(patch.keyPath ?? '').trim();
	}

	return result;
}

/**
 * 只有主进程会写入的 store 顶层键。
 *
 * 渲染进程在启动时读到的是快照，并在每次保存时把整个 store 回传，
 * 所以这些键必须在 saveStore 里被保护，否则运行期由主进程写入的值会被快照覆盖。
 */
const MAIN_PROCESS_OWNED_KEYS = ['remoteApi', 'remoteApiRunning', 'sshTunnel'] as const;

/** 白名单式地构造远程 API 配置补丁，绝不让渲染进程直接写 keyHash / keySalt 等字段 */
function sanitizeRemoteApiPatch(patch: any): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	if (!patch || typeof patch !== 'object') {
		return result;
	}
	if ('enabled' in patch) {
		result.enabled = Boolean(patch.enabled);
	}
	if ('port' in patch) {
		const port = Number(patch.port);
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			throw new Error('端口必须是 1024-65535 之间的整数');
		}
		result.port = port;
	}
	if ('bindAddress' in patch) {
		if (!REMOTE_API_BIND_ADDRESSES.includes(patch.bindAddress)) {
			throw new Error(`监听地址只能是 ${REMOTE_API_BIND_ADDRESSES.join(' 或 ')}`);
		}
		result.bindAddress = patch.bindAddress;
	}
	for (const key of ['launchTimeoutMs', 'closeTimeoutMs', 'maxConcurrentLaunches'] as const) {
		if (key in patch) {
			const value = Number(patch[key]);
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error(`${key} 必须是正数`);
			}
			result[key] = Math.floor(value);
		}
	}
	return result;
}

/** 需远程共享的方法 */
const methods = {
	autoLaunch,
	get: (url: string, config?: AxiosRequestConfig<any> | undefined) => axios.get(url, config).then((res) => res.data),
	getWithStatus: (url: string, config?: AxiosRequestConfig<any> | undefined) =>
		axios.get(url, { ...config, validateStatus: () => true }).then((res) => ({ status: res.status, data: res.data })),
	post: (url: string, config?: AxiosRequestConfig<any> | undefined) => axios.post(url, config).then((res) => res.data),
	download: (channel: string, url: string, dest: string) => {
		/** 下载文件 */
		return downloadFile(url, dest, (rate: any, totalLength: any, chunkLength: any) => {
			win?.webContents?.send('download', channel, rate, totalLength, chunkLength);
		});
	},
	zip: zip,
	unzip: unzip,
	getValidBrowsers: getValidBrowsers,
	getBrowserMajorVersion: getBrowserMajorVersion,
	getExtensionPaths: getExtensionPaths,
	systemProcesses: () => si.processes(),
	exportExcel: exportExcel,
	statisticFolderSize: statisticFolderSize,
	getPlatform: () => process.platform,
	updateApp: updateApp,
	moveWindowToTop: moveWindowToTop,
	isEncryptionAvailable: () => {
		return safeStorage.isEncryptionAvailable();
	},
	isDirectory: (path: string) => fs.statSync(path).isDirectory(),
	getRawScripts: () => JSON.parse(JSON.stringify(AutomationScripts)) as RawAutomationScript[],
	captureDesktopScreen: () => {
		return desktopCapturer.getSources({ types: ['window'] });
	},
	encryptRenderString,
	decryptRenderString,
	/** 一次性完成加密和存储，避免二次 IPC 调用 */
	saveStore: (plainStoreJson: string, shouldEncrypt: boolean): void => {
		const storeData: AppStore = JSON.parse(plainStoreJson);
		if (shouldEncrypt && safeStorage.isEncryptionAvailable()) {
			// @ts-ignore
			storeData.render = encryptRenderString(JSON.stringify(storeData.render));
		}

		/**
		 * 保留主进程独占的键。
		 *
		 * 渲染进程的 store 是应用启动时从主进程读的一份**快照**，它并不拥有这些键，
		 * 但 saveStore 是整体替换 store.store 的——若不在这里拦一道，
		 * 用户在设置页开启远程 API 后（值只写进了主进程），
		 * 下一次渲染进程保存就会用陈旧快照把它连同密钥一起覆盖掉。
		 * 表现为：开启后第一次调用正常，之后一律 404 NOT_ENABLED 且密钥凭空消失。
		 */
		for (const key of MAIN_PROCESS_OWNED_KEYS) {
			const authoritative = (store.store as Record<string, unknown>)[key];
			if (authoritative === undefined) {
				delete (storeData as Record<string, unknown>)[key];
			} else {
				(storeData as Record<string, unknown>)[key] = authoritative;
			}
		}

		store.store = storeData;
	},
	/** 远程 API 运行状态（不含密钥哈希与盐） */
	remoteApiGetStatus: () => getRemoteApiStatus(),
	/** 更新远程 API 配置并立即生效 */
	remoteApiUpdateConfig: async (patch: any) => {
		updateRemoteApiConfig(sanitizeRemoteApiPatch(patch));
		await restartRemoteApi();
		return getRemoteApiStatus();
	},
	/** 生成新密钥。明文只在此处返回一次，之后无法再取回 */
	remoteApiGenerateKey: async () => {
		const { apiKey } = generateApiKey();
		await restartRemoteApi();
		return { apiKey, status: getRemoteApiStatus() };
	},
	/** 使用调用方指定的密钥 */
	remoteApiSetKey: async (plaintext: string) => {
		if (typeof plaintext !== 'string' || plaintext.trim().length < 16) {
			throw new Error('密钥长度至少需要 16 个字符');
		}
		setApiKey(plaintext.trim());
		await restartRemoteApi();
		return getRemoteApiStatus();
	},
	remoteApiClearKey: async () => {
		clearApiKey();
		await restartRemoteApi();
		return getRemoteApiStatus();
	},
	/** 重新生成自签证书（会让调用方此前固定的指纹失效） */
	remoteApiRegenerateCert: async () => {
		await regenerateTlsMaterial();
		await restartRemoteApi();
		return getRemoteApiStatus();
	},

	// ── SSH 反向隧道 ──

	sshTunnelGetStatus: () => getSshTunnelStatus(),
	sshTunnelUpdateConfig: async (patch: any) => {
		updateSshTunnelConfig(sanitizeSshTunnelPatch(patch) as any);
		await restartTunnel();
		return getSshTunnelStatus();
	},
	/** 生成密钥。force=true 时重新生成——调用方需要先确认，旧的公钥会失效 */
	sshTunnelGenerateKey: async (force?: boolean) => {
		const info = await ensureKeyPair(Boolean(force));
		// 注意：重新生成的是**我们自己的**密钥，主机指纹是对方的，
		// 两者无关，所以不动 confirmedFingerprint。
		// 但换了新公钥后必须去 VPS 更新 authorized_keys，界面要提示。
		await restartTunnel();
		return { ...info, status: getSshTunnelStatus() };
	},
	/** 扫描目标主机公钥并算指纹，供用户确认（此时不建立隧道） */
	sshTunnelScanHostKey: async () => scanHostKey(),
	/** 用户确认指纹后写入自带的 known_hosts 并启动隧道 */
	sshTunnelConfirmHostKey: async () => {
		await confirmHostKey();
		return getSshTunnelStatus();
	},
	sshTunnelRestart: async () => {
		await restartTunnel();
		return getSshTunnelStatus();
	}
};

export type RemoteMethods = typeof methods;

/**
 * 初始化远程通信
 */
export function remoteRegister(_win: BrowserWindow) {
	win = _win;
	// 绑定远程 API 的反向调用通道，并把渲染进程的生命周期事件接进来
	attachRendererWindow(_win);
	registerRemoteEvent('electron-store', store);
	registerRemoteEvent('fs', fs);
	registerRemoteEvent('os', os);
	registerRemoteEvent('path', path);
	registerRemoteEvent('crypto', crypto);
	registerRemoteEvent('OCSApi', OCSApi);

	registerRemoteEvent('win', _win);
	registerRemoteEvent('webContents', _win.webContents);
	registerRemoteEvent('app', app);
	registerRemoteEvent('dialog', dialog);
	registerRemoteEvent('methods', methods);
	registerRemoteEvent('logger', Logger('render'));
	registerRemoteEvent('desktopCapturer', desktopCapturer);
}

const _registerRemoteEvent = registerRemoteEvent;
export { _registerRemoteEvent as registerRemoteEvent };

async function statisticFolderSize(dir: string) {
	const files = await readdir(dir, { withFileTypes: true });

	const paths: Promise<number>[] = files.map(async (file) => {
		const _path = path.join(dir, file.name);
		if (file.isDirectory()) return await statisticFolderSize(_path);

		if (file.isFile()) {
			const { size } = await stat(_path);
			return size;
		}
		return 0;
	});

	return (await Promise.all(paths)).flat().reduce((i, size) => i + size, 0);
}
