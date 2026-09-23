import { app } from 'electron';
import path from 'path';
import Store from 'electron-store';
import { getDecryptedRenderData } from './crypto';

// IO操作只能在 app.getPath('userData') 下进行，否则会有权限问题。

export const OriginalAppStore = {
	name: app.getName(),
	version: app.getVersion(),
	/** 路径数据 */
	paths: {
		'app-path': app.getAppPath(),
		'user-data-path': app.getPath('userData'),
		'exe-path': app.getPath('exe'),
		'logs-path': app.getPath('logs'),
		'config-path': path.resolve(app.getPath('userData'), './config.json'),
		/** 浏览器用户数据文件夹 */
		userDataDirsFolder: '',
		/** 浏览器下载文件夹 */
		downloadFolder: path.resolve(app.getPath('userData'), './downloads'),
		/** 加载拓展路径 */
		extensionsFolder: path.resolve(app.getPath('userData'), './downloads/extensions')
	},
	/** 软件设置 */
	app: {
		video_frame_rate: 1
	},
	/** 窗口设置 */
	window: {
		/** 开机自启 */
		alwaysOnTop: false,
		autoLaunch: false
	},
	/** 本地服务器数据 */
	server: {
		port: 15319,
		authToken: ''
	},
	/**
	 * 远程 API 配置
	 *
	 * 密钥只存 scrypt 哈希，明文不落盘（仅在生成时返回一次给设置页展示）。
	 * 出于安全考虑默认关闭，且默认只监听回环地址之外的接口需要用户显式开启。
	 *
	 * 注意：initStore() 只在版本号升高时才会用 defaultsDeep 补齐缺失键，
	 * 所以读取时务必用 getRemoteApiConfig() 做防御性合并，不要直接读 store.store.remoteApi。
	 */
	remoteApi: {
		enabled: false,
		port: 15320,
		bindAddress: '0.0.0.0',
		/** 密钥哈希算法标识，便于将来升级 */
		keyAlgo: 'scrypt',
		/** scrypt 盐（base64） */
		keySalt: '',
		/** scrypt 派生结果（base64，64 字节） */
		keyHash: '',
		/** 密钥生成时间，用于设置页展示 */
		keyCreatedAt: 0,
		/** 单次启动任务的超时时间（毫秒） */
		launchTimeoutMs: 10 * 60 * 1000,
		/** 关闭任务的超时时间（毫秒） */
		closeTimeoutMs: 30 * 1000,
		/** 同时进行中的启动任务上限 */
		maxConcurrentLaunches: 2
	},
	/**
	 * 渲染进程最近一次上报的「正在运行的浏览器 uid」清单。
	 * 渲染进程重载会清空它自己的 processes 表，而浏览器子进程仍在跑，
	 * 靠这份持久化记录才能对账出孤儿并如实上报。
	 */
	remoteApiRunning: {
		uids: [] as string[]
	},
	/**
	 * SSH 反向隧道配置。
	 *
	 * 用途：OCS 跑在没有公网 IP 的内网，而调用方在公网 VPS 上。
	 * 由本机主动连出去，把远程 API 的端口映射到 VPS 的回环地址。
	 *
	 * 私钥与 known_hosts 都放在应用数据目录的 ssh-tunnel/ 下，不碰用户的 ~/.ssh。
	 * 同样受 MAIN_PROCESS_OWNED_KEYS 保护（渲染进程的 store 是快照，会把它覆盖掉）。
	 */
	sshTunnel: {
		enabled: false,
		/** VPS 地址 */
		host: '',
		/** SSH 端口，注意未必是 22 */
		port: 22,
		user: '',
		/** 留空则用 PATH 中的 ssh */
		sshPath: '',
		/** 留空则用 <userData>/ssh-tunnel/id_ed25519 */
		keyPath: '',
		/** 用户已确认过的主机指纹；为空表示还没确认，此时不启动隧道 */
		confirmedFingerprint: ''
	},
	/** 渲染进程数据 */
	render: {} as { [x: string]: any }
};

/**
 * - electron 本地存储对象
 * - 可以使用 store.store 访问
 * - 设置数据请使用 store.set('key', value)
 */
export const store = new Store<typeof OriginalAppStore>();

/**
 * 获取解密后的渲染进程数据
 */
export { getDecryptedRenderData };
