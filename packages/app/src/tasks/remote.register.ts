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
