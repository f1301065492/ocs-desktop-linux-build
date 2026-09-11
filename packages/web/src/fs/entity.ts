import { EntityOptions, EntityTypes } from './interface';

export abstract class Entity implements EntityOptions {
	/** 原响应式对象 */
	abstract type: EntityTypes;
	uid: string;
	name: string;
	createTime: number;
	renaming: boolean;

	constructor(opts: EntityOptions) {
		this.uid = opts.uid;
		this.name = opts.name;
		this.createTime = opts.createTime;
		this.renaming = opts.renaming;
	}

	static uuid() {
		return uuid().replace(/-/g, '');
	}

	/** 定位 */
	abstract location(...args: any[]): void;
	/** 重命名 */
	abstract rename(...args: any[]): void;
	/** 删除 */
	abstract remove(...args: any[]): void;
	/** 选择 */
	abstract select(...args: any[]): void;
}

/**
 * 生成 uuid（32 位十六进制，无中划线）
 *
 * uid 不仅是实体标识，还会作为 userDataDir 的目录名被拼进 cachePath，
 * 一旦碰撞会导致两个浏览器共用同一个 Chromium profile（数据串味），
 * 所以优先使用 CSPRNG。
 *
 * crypto.randomUUID 需要安全上下文：Electron 的 file:// 与 dev 下的
 * localhost:3000 均满足；纯浏览器环境若以非安全上下文（如局域网 http）打开
 * 则不可用，此时退回旧实现。
 */
function uuid() {
	if (typeof globalThis.crypto?.randomUUID === 'function') {
		return globalThis.crypto.randomUUID();
	}
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}
