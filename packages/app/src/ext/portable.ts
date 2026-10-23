import crypto from 'crypto';

/**
 * 可移植加密（导出 / 导入跨机器）。
 *
 * 本机密钥链方案只能在同一台机器、同一个用户下解密，导出到别的电脑会报
 * “Unsupported state or unable to authenticate data”。可移植格式改用用户密码派生密钥
 * （scrypt + 随机盐），换机器只需输入同一个密码。
 *
 * 格式：`ocsdata:v2:<salt>:<iv>:<tag>:<ciphertext>`（base64）
 */

/** 可移植格式前缀（渲染进程 Title.vue 的导入判断依赖这个值） */
export const PORTABLE_PREFIX = 'ocsdata:v2:';

function toBytes(buf: Buffer): Uint8Array {
	return new Uint8Array(buf);
}

/** 用用户密码加密（跨机器可解） */
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
