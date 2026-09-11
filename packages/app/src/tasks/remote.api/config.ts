import crypto from 'crypto';
import defaultsDeep from 'lodash/defaultsDeep';
import { store, OriginalAppStore } from '../../store';

export type RemoteApiConfig = typeof OriginalAppStore.remoteApi;

/** scrypt 派生结果长度 */
const SCRYPT_KEYLEN = 64;

/** 校验成功结果的内存缓存时长（毫秒） */
const VERIFY_CACHE_TTL = 5 * 60 * 1000;
/** 校验成功结果的缓存容量上限 */
const VERIFY_CACHE_MAX = 64;

/** key: sha256(密钥明文)，value: 过期时间戳 */
const verifyCache = new Map<string, number>();

/**
 * 读取远程 API 配置。
 *
 * initStore() 只在版本号升高时才用 defaultsDeep 补齐缺失键，
 * 同版本重启（例如开发构建）不会补，所以这里必须防御性合并默认值，
 * 绝不能假设 store.store.remoteApi 存在或字段完整。
 */
export function getRemoteApiConfig(): RemoteApiConfig {
	return defaultsDeep({}, store.store.remoteApi ?? {}, OriginalAppStore.remoteApi) as RemoteApiConfig;
}

/** 更新配置（浅合并） */
export function updateRemoteApiConfig(patch: Partial<RemoteApiConfig>): RemoteApiConfig {
	const next = { ...getRemoteApiConfig(), ...patch };
	store.set('remoteApi', next);
	return next;
}

/** 是否已生成过密钥 */
export function hasApiKey(): boolean {
	const config = getRemoteApiConfig();
	return Boolean(config.keySalt && config.keyHash);
}

/**
 * 设置 API 密钥。明文不落盘，只保存 scrypt 派生结果与随机盐。
 * @returns 更新后的配置
 */
export function setApiKey(plaintext: string): RemoteApiConfig {
	const salt = crypto.randomBytes(32);
	const hash = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
	// 密钥已轮换，旧的校验缓存必须作废
	verifyCache.clear();
	return updateRemoteApiConfig({
		keyAlgo: 'scrypt',
		keySalt: salt.toString('base64'),
		keyHash: hash.toString('base64'),
		keyCreatedAt: Date.now()
	});
}

/**
 * 生成一个高熵随机密钥并落盘其哈希。
 * @returns apiKey 为明文，**只在这一刻返回一次**，之后无法再取回
 */
export function generateApiKey(): { apiKey: string; config: RemoteApiConfig } {
	const apiKey = crypto.randomBytes(32).toString('base64url');
	return { apiKey, config: setApiKey(apiKey) };
}

/** 清空密钥（同时清缓存） */
export function clearApiKey(): RemoteApiConfig {
	verifyCache.clear();
	return updateRemoteApiConfig({ keySalt: '', keyHash: '', keyCreatedAt: 0 });
}

function derive(plaintext: string, salt: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		// 用异步版本：同步的 scryptSync 会阻塞主进程事件循环（也承载着窗口与 IPC），
		// 每次请求卡住上百毫秒是不可接受的
		crypto.scrypt(plaintext, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
			if (err) reject(err);
			else resolve(derivedKey);
		});
	});
}

function cacheKeyOf(plaintext: string): string {
	return crypto.createHash('sha256').update(plaintext).digest('base64');
}

function readCache(plaintext: string): boolean {
	const key = cacheKeyOf(plaintext);
	const expiresAt = verifyCache.get(key);
	if (expiresAt === undefined) return false;
	if (expiresAt <= Date.now()) {
		verifyCache.delete(key);
		return false;
	}
	return true;
}

function writeCache(plaintext: string): void {
	if (verifyCache.size >= VERIFY_CACHE_MAX) {
		// 简单淘汰：清掉已经过期的，若仍然满则整体清空
		const now = Date.now();
		for (const [key, expiresAt] of verifyCache) {
			if (expiresAt <= now) verifyCache.delete(key);
		}
		if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.clear();
	}
	verifyCache.set(cacheKeyOf(plaintext), Date.now() + VERIFY_CACHE_TTL);
}

/**
 * 校验 API 密钥。
 *
 * 设计上「永不抛出」：任何异常（配置损坏、盐不是合法 base64 等）都视为校验失败，
 * 让调用方统一返回 401，绝不把内部异常泄漏到 HTTP 层。
 *
 * 只缓存**成功**结果：失败路径必须每次都真正跑一遍 scrypt，
 * 这样在线爆破的成本才不会被缓存绕开。
 */
export async function verifyApiKey(provided: unknown): Promise<boolean> {
	try {
		if (typeof provided !== 'string' || provided.length === 0) {
			return false;
		}
		if (readCache(provided)) {
			return true;
		}
		const config = getRemoteApiConfig();
		if (!config.keySalt || !config.keyHash) {
			return false;
		}
		const expected = Buffer.from(config.keyHash, 'base64');
		const actual = await derive(provided, Buffer.from(config.keySalt, 'base64'));
		// 两侧都是定长 SCRYPT_KEYLEN 字节，不会触发 timingSafeEqual 对不等长 buffer 抛异常
		if (actual.length !== expected.length) {
			return false;
		}
		const matched = crypto.timingSafeEqual(actual, expected);
		if (matched) {
			writeCache(provided);
		}
		return matched;
	} catch {
		return false;
	}
}

/** 供设置页展示的配置摘要（**绝不包含哈希与盐**） */
export function getRemoteApiPublicConfig() {
	const config = getRemoteApiConfig();
	return {
		enabled: config.enabled,
		port: config.port,
		bindAddress: config.bindAddress,
		hasKey: hasApiKey(),
		keyCreatedAt: config.keyCreatedAt
	};
}
