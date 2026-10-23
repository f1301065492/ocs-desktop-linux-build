import forge from 'node-forge';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { store } from '../../store';
import { Logger } from '../../logger';

const logger = Logger('remote-api');

const CERT_DIR_NAME = 'remote-api';
const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';

/** 自签证书有效期（年） */
const CERT_YEARS = 10;

export interface TlsMaterial {
	key: string;
	cert: string;
	/** SHA-256 指纹，供调用方做证书固定 */
	fingerprint: string;
	/** 生成时间（毫秒）。0 表示本次未新生成，复用了已有证书 */
	generatedAt: number;
}

function certDir(): string {
	return path.resolve(store.store.paths['user-data-path'], './' + CERT_DIR_NAME);
}

/** 收集本机可用的对外 IP，用于写进证书的 SAN */
function collectHostIps(): string[] {
	const ips = new Set<string>();
	const interfaces = os.networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const info of interfaces[name] ?? []) {
			// family 在不同 Node 版本下可能是 'IPv4' 也可能是 4，两种都兼容
			const family = String(info.family);
			if ((family === 'IPv4' || family === '4') && !info.internal) {
				ips.add(info.address);
			}
		}
	}
	return [...ips];
}

/** 计算证书的 SHA-256 指纹（大写冒号分隔十六进制） */
export function fingerprintOf(certPem: string): string {
	const match = certPem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
	if (!match) {
		return '';
	}
	const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
	const digest = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
	return digest.match(/../g)?.join(':') ?? '';
}

function generateSelfSigned(): Promise<{ key: string; cert: string }> {
	return new Promise((resolve, reject) => {
		const pki = forge.pki;
		// 用异步版本：2048 位 RSA 生成要 1~3 秒，
		// 同步的 generateKeyPair 会把主进程（含窗口与 IPC）整个卡住
		pki.rsa.generateKeyPair({ bits: 2048 }, (err, keypair) => {
			if (err) {
				reject(err);
				return;
			}
			try {
				const cert = pki.createCertificate();
				cert.publicKey = keypair.publicKey;
				cert.serialNumber = crypto.randomBytes(16).toString('hex');
				cert.validity.notBefore = new Date();
				cert.validity.notAfter = new Date();
				cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + CERT_YEARS);

				const attrs = [
					{ name: 'commonName', value: 'ocs-desktop-remote-api' },
					{ name: 'organizationName', value: 'OCS Desktop' }
				];
				// 自签证书的 issuer 必须与 subject 一致
				cert.setSubject(attrs);
				cert.setIssuer(attrs);

				const altNames: Array<{ type: number; value?: string; ip?: string }> = [{ type: 2, value: 'localhost' }];
				for (const ip of collectHostIps()) {
					altNames.push({ type: 7, ip });
				}

				cert.setExtensions([
					{ name: 'basicConstraints', cA: true },
					{ name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
					{ name: 'extKeyUsage', serverAuth: true },
					{ name: 'subjectAltName', altNames }
				]);

				cert.sign(keypair.privateKey, forge.md.sha256.create());

				resolve({
					cert: pki.certificateToPem(cert),
					key: pki.privateKeyToPem(keypair.privateKey)
				});
			} catch (e) {
				reject(e);
			}
		});
	});
}

/** 强制重新生成证书。会使调用方此前固定的指纹失效。 */
export async function regenerateTlsMaterial(): Promise<TlsMaterial> {
	const { key, cert } = await generateSelfSigned();
	const dir = certDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, CERT_FILE), cert, { mode: 0o644 });
	fs.writeFileSync(path.join(dir, KEY_FILE), key, { mode: 0o600 });
	logger.info(`已重新生成自签证书，SAN IP: ${collectHostIps().join(', ') || '(无)'}`);
	return { key, cert, fingerprint: fingerprintOf(cert), generatedAt: Date.now() };
}

/**
 * 读取或首次生成自签证书。
 *
 * 不因为本机 IP 变化而自动重新生成：重新生成会更换指纹，
 * 让调用方此前配置的证书固定静默失效。需要新 SAN 时由用户显式触发。
 */
export async function ensureTlsMaterial(): Promise<TlsMaterial> {
	const dir = certDir();
	const certPath = path.join(dir, CERT_FILE);
	const keyPath = path.join(dir, KEY_FILE);

	if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
		try {
			const cert = fs.readFileSync(certPath, 'utf8');
			const key = fs.readFileSync(keyPath, 'utf8');
			return { key, cert, fingerprint: fingerprintOf(cert), generatedAt: 0 };
		} catch (err) {
			logger.warn(`读取已有证书失败，将重新生成: ${String(err)}`);
		}
	}

	return regenerateTlsMaterial();
}

/** 列出本机可用于拼接访问地址的 IP */
export function listLocalAddresses(): string[] {
	return collectHostIps();
}
