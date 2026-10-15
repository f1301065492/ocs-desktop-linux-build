import { OriginalAppStore } from './src/store';
import { ScriptWorker } from './src/worker';

export { RemoteMethods } from './src/tasks/remote.register';
export type AppStore = typeof OriginalAppStore;

export { ScriptWorker };

export interface UserScripts {
	id: number;
	/** 用户脚本链接 */
	url: string;
	/** 启动自动安装脚本 */
	enable: boolean;
	/**
	 * 脚本信息
	 */
	info: any;
	/** 是否为本地脚本 */
	isLocalScript: boolean;
	/** 是否为网络链接加载的脚本 */
	isInternetLinkScript: boolean;
	/**
	 * 上次安装的版本（历史字段，已废弃）。
	 *
	 * 它记录在脚本条目上、全软件共用，会导致新建的浏览器被误判成「已装最新版」，
	 * 也分不清是哪个 profile 装的。现在改为按浏览器记在
	 * Browser.userscriptVersions 上，这里仅保留老数据不再读写。
	 */
	lastInstalledVersion?: string;
	/** 脚本信息上次更新时间（最新版本、描述等信息），0 表示从未更新 */
	lastInfoUpdateTime?: number;
}
