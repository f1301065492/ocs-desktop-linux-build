import { reactive } from 'vue';
import { remote } from '../utils/remote';
import defaultsDeep from 'lodash/defaultsDeep';
import type { AppStore, UserScripts } from '@ocs-desktop/app';
import { CommonUserScript } from '../types/user.script';
import { FolderOptions } from '../fs/interface';
import { Browser } from '../fs/browser';
import { Folder } from '../fs/folder';

export type StoreUserScript = { info?: CommonUserScript } & Omit<UserScripts, 'info'>;

export type WebStore = {
	scripts: StoreUserScript[];
	notifies: any[];

	browser: {
		currentFolderUid: string;
		currentBrowserUid: string;
		/** 根目录 */
		root: FolderOptions<'root', Browser | Folder>;
		tags: Record<string, { color: string; count: number }>;
		search: {
			/** 名字或者备注搜素 */
			value: string;
			tags: string[];
		};
	};
	dashboard: {
		/** 显示标签和备注 */
		details: {
			tags: boolean;
			notes: boolean;
		};
		/** 列数控制 */
		num: number;
		/** 视频设置 */
		video: {
			/** 横纵比 */
			aspectRatio?: number;
		};
	};
	setting: {
		browserType: 'diy' | 'local' | 'setup';
		/** 界面模式：简洁模式 / 专业模式 */
		mode: 'simple' | 'professional';
		/** 是否显示侧边栏文字 */
		showSideBarText: boolean;
		/** 浏览器启动参数 */
		launchOptions: {
			custom: boolean;
			executablePath: string;
		};
		/** 当前的主题 */
		theme: {
			dark: boolean;
		};
		/** ocs 特殊配置 */
		ocs: {
			/** 当前配置名 */
			currentProjectName: string;
			/** 全局配置 */
			store: any;
			/** 是否同步OCS配置 */
			openSync: boolean;
		};
		browser: {
			/** 浏览器缓存大小预警阈值（GB） */
			cachesSizeWarningPoint: number;
			/** 是否启用浏览器原版对话框 */
			enableDialog: boolean;
			/** 是否强制更新/安装脚本 */
			forceUpdateScript: boolean;
			/**
			 * 每次启动浏览器前清除登录状态（cookie / 站点本地存储）。
			 *
			 * 开着它就等于「每次启动都是一次全新登录」：不会再出现「首页显示已登录、点进课程
			 * 却被踢回登录页」这种会话失效的状态。代价是启动要重走一遍登录（可能还要过验证码），
			 * 所以要配合登录类自动化程序用。
			 */
			clearLoginOnLaunch: boolean;
			/** 点击「新建浏览器」时是否自动打开初始化弹窗并执行初始化 */
			autoInitNewBrowser: boolean;
		};
		/** DSH 主动通知（ocs-watch 常驻进程 + 实时推送） */
		dshNotify: {
			/** 是否随 OCS 启动并常驻 */
			enabled: boolean;
			/** 实时推送：脚本事件/错误秒级发给主进程（轮询仍作为兜底） */
			realtime: boolean;
			/** 轮询间隔（秒） */
			intervalSec: number;
			/** DSH IM 机器人的 Bot ID */
			botId: string;
			/** DSH 投递目标 ID */
			targetId: string;
			/** 投递接口地址（留空用 http://127.0.0.1:3080/...） */
			deliveryUrl: string;
			/** OCS 远程 API 密钥（随 renderer store 加密保存，供下次启动时自动运行） */
			apiKey: string;
		};
	};

	langs: Record<string, string>;
	state: {
		/** 是否第一次打开 */
		first: boolean;
		/** 是否展示初始化设置  */
		setup: boolean;
		/** 是否展示「新建浏览器自动初始化」弹窗 */
		newBrowserSetup: boolean;
		mini: boolean;
		responsive: 'mini' | 'small';
		height: number;
		/** 已读的提示记录 */
		read_record: {
			user_script_usage: boolean;
			browser_usage: boolean;
			automation_script_usage: boolean;
		};
	};
};

/** DSH 主动通知的默认值（旧版本数据里没有这个键，解密后需要补） */
const DEFAULT_DSH_NOTIFY = {
	enabled: false,
	realtime: true,
	intervalSec: 5,
	botId: '',
	targetId: '',
	deliveryUrl: '',
	apiKey: ''
};

const _store: AppStore & { render: WebStore } = defaultsDeep(remote['electron-store'].get('store'), {
	render: {
		scripts: [],
		notifies: [],
		browser: {
			currentFolderUid: '',
			currentBrowserUid: '',
			root: {
				name: '根目录',
				parent: undefined,
				createTime: Date.now(),
				type: 'root',
				uid: 'root-folder',
				children: {},
				renaming: false
			},
			tags: {},
			search: {
				value: '',
				tags: [],
				results: undefined
			}
		},
		dashboard: {
			details: {
				tags: false,
				notes: false
			},
			num: 4,
			video: {
				aspectRatio: 0
			}
		},
		setting: {
			browserType: 'diy',
			mode: 'simple' as const,
			showSideBarText: true,
			launchOptions: {
				custom: false,
				executablePath: ''
			},
			theme: {
				dark: false
			},
			ocs: {
				currentProjectName: '',
				store: {},
				openSync: false
			},
			browser: {
				cachesSizeWarningPoint: 10,
				enableDialog: false,
				forceUpdateScript: false,
				// 默认关：开着会让每次启动都重走一遍登录，得配了登录类自动化程序才划算
				clearLoginOnLaunch: false,
				autoInitNewBrowser: true
			},
			dshNotify: {
				...DEFAULT_DSH_NOTIFY
			}
		},
		langs: {},
		state: {
			first: true,
			setup: true,
			newBrowserSetup: false,
			mini: false,
			responsive: 'small',
			height: document.documentElement.clientHeight,
			read_record: {
				user_script_usage: false,
				browser_usage: false,
				automation_script_usage: false
			}
		}
	} as WebStore
});

// 解密数据（兼容新旧加密格式）
// @ts-ignore - render 在磁盘上可能是加密后的字符串
if (typeof _store.render === 'string') {
	try {
		console.log('_store', _store);
		// @ts-ignore
		const renderStr = _store.render as string;
		const data = JSON.parse(remote.methods.callSync('decryptRenderString' as any, renderStr));
		// 旧数据里没有新增设置项（如 dshNotify）：用默认值补齐，避免设置页读到 undefined
		if (data && data.setting) {
			data.setting.dshNotify = { ...DEFAULT_DSH_NOTIFY, ...(data.setting.dshNotify || {}) };
		}
		Reflect.set(_store, 'render', data);
	} catch (e) {
		console.error('数据解密失败：' + e);
	}
}

/** 数据存储对象 */
export const store: AppStore & { render: WebStore } = reactive(_store);

console.log('store', store);
// @ts-ignore
window.store = store;

/** 根目录 */
export const files = reactive<File[]>([]);

/** 打开的文件 */
export const openedFiles = reactive(new Map<string, File>());

export function lang(key: string, def?: string, params?: Record<string, any>) {
	let text = store.render.langs[key];
	if (!text) {
		text = def || '';
	}
	if (params) {
		Object.keys(params).forEach((k) => {
			text = text.replace(new RegExp(`{{${k}}}`, 'g'), params[k]);
		});
	}
	return text;
}
