/**
 * 扩展功能写入 electron-store 的默认配置。
 *
 * 由 `src/store.ts` 展开进 `OriginalAppStore`——上游文件里只留一行适配，
 * 新增配置项集中在这里，便于对照上游更新。
 *
 * 这些键都属于「主进程独占」：渲染进程的 store 是启动快照，
 * 保存时会整体回传，必须在 saveStore 里保护（见 ext/ipc.ts 的 MAIN_PROCESS_OWNED_KEYS）。
 */
export const EXT_APP_STORE_DEFAULTS = {
	/**
	 * 远程 API 配置。
	 *
	 * 密钥只存 scrypt 哈希，明文不落盘（仅在生成时返回一次给设置页展示）。
	 * 默认关闭；需要跨机访问时由用户在设置页显式开启。
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
		/** 加密保存的密钥明文（供设置页自动回填；密钥链不可用时为空） */
		keyEnc: '',
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
	 * 软件更新源。
	 *
	 * github = 官方 Releases（默认）；mirror = 自建镜像，读取 `<mirrorBase>/latest.json`。
	 */
	update: {
		source: 'github' as 'github' | 'mirror',
		mirrorBase: ''
	},
	/**
	 * SSH 反向隧道配置。
	 *
	 * 用途：OCS 跑在没有公网 IP 的内网，而调用方在公网 VPS 上。
	 * 由本机主动连出去，把远程 API 的端口映射到 VPS 的回环地址。
	 *
	 * 私钥与 known_hosts 都放在应用数据目录的 ssh-tunnel/ 下，不碰用户的 ~/.ssh。
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
	}
};
