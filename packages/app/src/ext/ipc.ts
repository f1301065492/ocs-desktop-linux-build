import type { BrowserWindow } from 'electron';
import { store } from '../store';
import { getUpdateSourceConfig, setUpdateSourceConfig } from './update/source';
import { encryptPortable, decryptPortable } from './portable';
import { attachRendererWindow, getRemoteApiStatus, restartRemoteApi } from './remote-api';
import {
	clearApiKey,
	generateApiKey,
	rememberApiKey,
	revealApiKey,
	setApiKey,
	updateRemoteApiConfig
} from './remote-api/config';
import { regenerateTlsMaterial } from './remote-api/tls';
import { detectDsh, detectDshConnection, grantDshAccess, writeDshProfile } from './dsh/bridge';
import { imPatchStatus, patchImBridge } from './dsh/im';
import { dshNotifyStatus, pushRealtimeNotify, startDshNotify, stopDshNotify, testDshNotify } from './dsh/notify';
import type { DshNotifyInput } from './dsh/notify';
import {
	confirmHostKey,
	ensureKeyHealthy,
	ensureKeyPair,
	getSshTunnelStatus,
	restartTunnel,
	scanHostKey,
	updateSshTunnelConfig
} from './ssh/tunnel';
import { isDebUpdateDownloadPaused, pauseDebUpdateDownload, resumeDebUpdateDownload } from './update/deb';

/**
 * 扩展功能通过 IPC 暴露给渲染进程的方法集合。
 *
 * `tasks/remote.register.ts` 只把它们展开进 `methods`（一行），
 * 这样上游更新该文件时冲突面最小。新增方法请加在这里。
 */

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
const MAIN_PROCESS_OWNED_KEYS = ['remoteApi', 'remoteApiRunning', 'sshTunnel', 'update'] as const;

/**
 * 保存 store 前，用主进程内存里的权威值覆盖渲染进程回传的快照。
 *
 * 不这么做的话：用户在设置页开启远程 API 后（值只写进了主进程），
 * 下一次渲染进程保存就会用陈旧快照把它连同密钥一起覆盖掉，
 * 表现为「开启后第一次调用正常，之后一律 404 NOT_ENABLED 且密钥凭空消失」。
 */
export function protectMainProcessOwnedKeys(storeData: Record<string, unknown>): void {
	for (const key of MAIN_PROCESS_OWNED_KEYS) {
		const authoritative = (store.store as unknown as Record<string, unknown>)[key];
		if (authoritative === undefined) {
			delete storeData[key];
		} else {
			storeData[key] = authoritative;
		}
	}
}

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

/** 需远程共享的扩展方法（展开进 remote.register 的 methods） */
export const EXT_METHODS = {
	/** deb 更新下载：暂停 / 继续 / 状态（更新弹窗按钮用） */
	pauseUpdateDownload: () => pauseDebUpdateDownload(),
	resumeUpdateDownload: () => resumeDebUpdateDownload(),
	isUpdateDownloadPaused: () => isDebUpdateDownloadPaused(),

	/** 更新源配置：github / mirror */
	updateSourceGet: () => getUpdateSourceConfig(),
	updateSourceSet: (input: { source?: 'github' | 'mirror'; mirrorBase?: string }) => setUpdateSourceConfig(input),

	// 可移植（密码）加解密：导出/导入跨机器用
	encryptPortable,
	decryptPortable,

	/**
	 * 主进程的运行环境（只取与显示/路径相关的变量）。
	 *
	 * 渲染进程的 `process.env` 在 Electron 下可能不完整（sandbox/环境隔离），
	 * 直接用它 fork worker 会丢掉 DISPLAY，即使 OCS 是用 xvfb-run 启动的。
	 */
	getRuntimeEnv: (): Record<string, string> => {
		const keys = ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];
		const env: Record<string, string> = {};
		for (const key of keys) {
			const value = process.env[key];
			if (value) {
				env[key] = value;
			}
		}
		return env;
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
	/** 设置页回填用：取回加密保存的密钥明文（没有加密副本时为空串） */
	remoteApiRevealKey: () => revealApiKey(),
	/** 用户手工粘贴密钥后，校验通过则补一份加密副本，供下次自动回填 */
	remoteApiRememberKey: (plaintext: string) => rememberApiKey(plaintext),
	/** 重新生成自签证书（会让调用方此前固定的指纹失效） */
	remoteApiRegenerateCert: async () => {
		await regenerateTlsMaterial();
		await restartRemoteApi();
		return getRemoteApiStatus();
	},

	// ── DSH（DeepSeek Harness）接入 ──

	/** 检测本机 DSH 与随应用发布的桥接脚本，并带上远程 API 的当前状态 */
	dshBridgeStatus: (input?: { dshHome?: string }) => {
		const api = getRemoteApiStatus();
		return {
			...detectDsh(input?.dshHome),
			remoteApi: {
				enabled: api.enabled,
				listening: api.listening,
				port: api.port,
				bindAddress: api.bindAddress,
				hasKey: api.hasKey,
				certFingerprint: api.certFingerprint
			}
		};
	},
	/** 把 OCS 的 MCP 桥接配置写进指定 DSH profile（受管块，重复执行幂等） */
	dshBridgeWrite: (input: {
		profile: string;
		ocsBase: string;
		apiKey: string;
		certFingerprint?: string;
		dshHome?: string;
		toolset?: 'basic' | 'full';
	}) => writeDshProfile(input),
	/** 跨用户场景：弹系统认证框，给 OCS 用户授权读写 DSH 配置目录（一次性） */
	dshBridgeGrantAccess: (input?: { dshHome?: string }) => grantDshAccess(input),
	/** 设置页状态图标：DSH 主进程与 OCS 桥接进程是否都在运行 */
	dshConnectionStatus: () => detectDshConnection(),
	/** 飞书机器人 /ocs 补丁：查询是否已写入 */
	dshImPatchStatus: (input?: { dshHome?: string; profile?: string }) => imPatchStatus(input),
	/** 飞书机器人 /ocs 补丁：写入 / 修复（幂等，失败自动回滚） */
	dshImPatch: (input?: { dshHome?: string; profile?: string }) => patchImBridge(input),

	// ── 主动通知（OCS → DSH，零 token） ──
	dshNotifyStatus: () => dshNotifyStatus(),
	dshNotifyStart: (input: DshNotifyInput) => startDshNotify(input),
	dshNotifyStop: () => stopDshNotify(),
	dshNotifyTest: (input: DshNotifyInput) => testDshNotify(input),
	/** 渲染进程实时上报（秒级），主进程负责过滤、去重与投递 */
	dshNotifyPush: (input: { entries?: { name: string; line: string }[]; lines?: string[] }) => pushRealtimeNotify(input),

	// ── SSH 反向隧道 ──

	/**
	 * 读状态前先做一次密钥配对校验（异步，因为要跑 ssh-keygen）。
	 *
	 * 放在这里是为了让设置页**在用户复制公钥之前**就把坏掉的公钥文件修好：
	 * 否则用户复制走的正是那个与私钥对不上的公钥，装到 VPS 上又是一轮白排查。
	 */
	sshTunnelGetStatus: async () => {
		await ensureKeyHealthy();
		return getSshTunnelStatus();
	},
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

export type ExtMethods = typeof EXT_METHODS;

/**
 * 与上游 remote.register.ts 的另一个接点：
 * 绑定远程 API 的反向调用通道，把渲染进程生命周期事件接进来。
 */
export function attachExtIpc(win: BrowserWindow): void {
	attachRendererWindow(win);
}
