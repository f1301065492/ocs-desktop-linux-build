import { safeStorage } from 'electron';
import crypto from 'crypto';
import keytar from 'keytar';
import { Logger } from './logger';

let cachedLogger: ReturnType<typeof Logger> | null = null;
/** 延迟创建 logger：脱离 Electron 跑单测时没有 app，退回 console */
function getLogger(): ReturnType<typeof Logger> {
	if (!cachedLogger) {
		try {
			cachedLogger = Logger('crypto');
		} catch {
			cachedLogger = console as unknown as ReturnType<typeof Logger>;
		}
	}
	return cachedLogger;
}

// --- 常量 ---
const SERVICE_NAME = 'ocs-desktop';
const ACCOUNT_NAME = 'aes-key';

// --- 状态 ---
let cachedAesKey: Buffer | null = null;

/**
 * 异步初始化加密模块
 *
 * 两种加密方案：
 * 1. keytar + AES：密钥存入 OS 密钥链，用 AES-256-GCM 加解密数据（优先）
 * 2. safeStorage：Electron safeStorage 直通加解密（降级）
 *
 * ⚠️ 必须在 initStore() 之前调用
 */
export async function initAesKey(): Promise<void> {
	if (cachedAesKey) return;

	try {
		// ── keytar 方案 ──

		// 从密钥链读取已有密钥
		const hex = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
		if (hex) {
			cachedAesKey = Buffer.from(hex, 'hex');
			getLogger().info('从密钥链加载 AES 密钥');
			return;
		}

		// 密钥链中没有，生成新密钥并存入
		cachedAesKey = crypto.randomBytes(32);
		await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, cachedAesKey.toString('hex'));
		getLogger().info('生成新 AES 密钥并存入密钥链');
	} catch (e) {
		// keytar 不可用时 cachedAesKey 保持 null，所有加解密走 safeStorage
		getLogger().warn('keytar 初始化失败，使用 safeStorage 方案', e);
	}
}

/**
 * AES 密钥是否可用（即 keytar 方案是否生效）
 */
export function isAesAvailable(): boolean {
	return cachedAesKey !== null;
}

/**
 * 同步获取缓存的 AES 密钥
 * ⚠️ 仅在 isAesAvailable() 为 true 时调用
 */
export function getAesKey(): Buffer {
	if (!cachedAesKey) {
		throw new Error('AES key not available. keytar is not loaded.');
	}
	return cachedAesKey;
}

// ────────────────────────────────────────────
//  AES-256-GCM 加解密（keytar 方案专用）
// ────────────────────────────────────────────

/**
 * 将 Buffer 转为 TS 5.7+ 兼容的 Uint8Array<ArrayBuffer>
 *
 * TS 5.7+ 将 Buffer 视为 Uint8Array<ArrayBufferLike>（.buffer 可能为 SharedArrayBuffer），
 * 无法赋给期望 ArrayBufferView<ArrayBuffer> 的 crypto API 形参（CipherKey / BinaryLike 等）。
 * 这里拷贝为一份新的 Uint8Array<ArrayBuffer> 以满足类型签名。
 */
function toBytes(buf: Buffer): Uint8Array {
	return new Uint8Array(buf);
}

/**
 * AES-256-GCM 加密
 * @returns 格式: iv:authTag:ciphertext（base64 编码）
 */
export function encryptAes(plaintext: string): string {
	const key = getAesKey();
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', toBytes(key), toBytes(iv));
	let encrypted = cipher.update(plaintext, 'utf8', 'base64');
	encrypted += cipher.final('base64');
	const authTag = cipher.getAuthTag();
	return iv.toString('base64') + ':' + authTag.toString('base64') + ':' + encrypted;
}

/**
 * AES-256-GCM 解密
 * @param ciphertext 格式: iv:authTag:ciphertext
 */
export function decryptAes(ciphertext: string): string {
	const key = getAesKey();
	const parts = ciphertext.split(':');
	const iv = Buffer.from(parts[0], 'base64');
	const authTag = Buffer.from(parts[1], 'base64');
	const data = parts.slice(2).join(':');
	const decipher = crypto.createDecipheriv('aes-256-gcm', toBytes(key), toBytes(iv));
	decipher.setAuthTag(toBytes(authTag));
	let decrypted = decipher.update(data, 'base64', 'utf8');
	decrypted += decipher.final('utf8');
	return decrypted;
}

// ────────────────────────────────────────────
//  可移植加密（导出/导入跨机器）
// ────────────────────────────────────────────

/** 可移植格式前缀 */
export const PORTABLE_PREFIX = 'ocsdata:v2:';

/**
 * 用用户密码加密（跨机器可解）。
 *
 * 本机密钥链方案只能在同一台机器/同一个用户下解密，导出到别的电脑会报
 * "Unsupported state or unable to authenticate data"。可移植格式改用密码派生密钥
 * （scrypt + 随机盐），换机器只需输入同一个密码。
 *
 * 格式：`ocsdata:v2:<salt>:<iv>:<tag>:<ciphertext>`（base64）
 */
export function encryptPortable(plaintext: string, password: string): string {
	const salt = crypto.randomBytes(16);
	const iv = crypto.randomBytes(12);
	const key = crypto.scryptSync(password, salt, 32);
	const cipher = crypto.createCipheriv('aes-256-gcm', toBytes(key), toBytes(iv));
	let data = cipher.update(plaintext, 'utf8', 'base64');
	data += cipher.final('base64');
	const tag = cipher.getAuthTag();
	return PORTABLE_PREFIX + [salt, iv, tag].map((item) => item.toString('base64')).join(':') + ':' + data;
}

/** 判断是否为可移植格式 */
export function isPortableData(value: unknown): boolean {
	return typeof value === 'string' && value.startsWith(PORTABLE_PREFIX);
}

/** 用密码解密可移植数据；密码错误会抛出 GCM 校验失败 */
export function decryptPortable(payload: string, password: string): string {
	if (!isPortableData(payload)) {
		throw new Error('不是可移植格式的数据');
	}
	const parts = String(payload).slice(PORTABLE_PREFIX.length).split(':');
	if (parts.length < 4) {
		throw new Error('可移植数据格式不完整');
	}
	const salt = Buffer.from(parts[0], 'base64');
	const iv = Buffer.from(parts[1], 'base64');
	const tag = Buffer.from(parts[2], 'base64');
	const data = parts.slice(3).join(':');
	const key = crypto.scryptSync(password, salt, 32);
	const decipher = crypto.createDecipheriv('aes-256-gcm', toBytes(key), toBytes(iv));
	decipher.setAuthTag(toBytes(tag));
	return decipher.update(data, 'base64', 'utf8') + decipher.final('utf8');
}

// ────────────────────────────────────────────
//  渲染进程数据加解密（自适应方案）
// ────────────────────────────────────────────

/**
 * 加密渲染进程数据
 * - keytar 可用 → AES-256-GCM（格式: iv:authTag:ciphertext）
 * - keytar 不可用 → safeStorage 直通（格式: 纯 base64）
 */
export function encryptRenderString(plaintext: string): string {
	if (isAesAvailable()) {
		return encryptAes(plaintext);
	}
	return safeStorage.encryptString(plaintext).toString('base64');
}

/**
 * 解密渲染进程数据（自适应新旧格式）
 * - 含冒号 → AES-256-GCM 格式（keytar 方案）
 * - 纯 base64 → safeStorage 格式（旧数据）
 */
export function decryptRenderString(encrypted: string): string {
	if (encrypted.includes(':')) {
		return decryptAes(encrypted);
	}
	// safeStorage 格式
	return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
}

/**
 * 获取解密后的渲染进程数据
 */
export function getDecryptedRenderData(store: { store: { render: any } }): any {
	if (typeof store?.store?.render === 'string') {
		return JSON.parse(decryptRenderString(store.store.render));
	}
	return store?.store?.render || {};
}
