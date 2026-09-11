import { RawAutomationScript } from '../components/automation-scripts';

export type FolderType = 'folder' | 'root';
export type BrowserType = 'browser';
export type EntityTypes = BrowserType | FolderType;

/** 实体 */
export interface EntityOptions {
	type: EntityTypes;
	/** 实体id */
	uid: string;
	/** 实体名 */
	name: string;
	/** 创建时间 */
	createTime: number;
	/** 是否重命名中 */
	renaming: boolean;
}

export interface Tag {
	/** 标签名字 */
	name: string;
	/** 颜色 */
	color: string;
}

/**
 * 浏览器操作历史记录
 */
export interface BrowserOperateHistory {
	action: '运行' | '重启' | '关闭' | '创建' | '改名' | '添加标签' | '删除标签' | '备注';
	content?: string;
	time: number;
}

/**
 * 远程 API 创建的浏览器所携带的元数据。
 *
 * 必须作为实体字段持久化（而不是放主进程内存），
 * 因为远程 API 的任务表不持久化，应用重启后调用方只能靠 clientToken
 * 在浏览器树里反查自己创建过的实例。这里随浏览器树一起落在加密后的 config.json 中。
 */
export interface BrowserRemoteMeta {
	/** 调用方提供的幂等键 */
	clientToken?: string;
	/** 创建来源 */
	source: 'remote' | 'ui';
	/** 创建时间 */
	createdAt: number;
}

/** 浏览器 */
export interface BrowserOptions extends EntityOptions {
	type: BrowserType;
	parent: string;
	/** 浏览器标签 */
	tags: Tag[];
	/** 浏览器备注 */
	notes: string;
	/** 是否选中 */
	checked: boolean;
	/** 缓存路径 */
	cachePath: string;
	renaming: boolean;
	/** 历史 */
	histories: BrowserOperateHistory[];
	/** 自动化程序列表 */
	automationScripts: RawAutomationScript[];
	/** 远程 API 元数据，仅远程创建的实例会有 */
	remoteMeta?: BrowserRemoteMeta;
}

/**
 * 浏览器文件夹
 */
export interface FolderOptions<T extends FolderType, ChildType> extends EntityOptions {
	type: T;
	parent: T extends 'root' ? undefined : string;
	children: Record<string, ChildType>;
}
