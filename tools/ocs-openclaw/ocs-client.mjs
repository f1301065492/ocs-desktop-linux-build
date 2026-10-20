/**
 * OCS Desktop 远程 API 的极简客户端（零依赖，Node 20+）。
 *
 * 之所以零依赖：这套东西要放到**另一台机器**（装 OpenClaw 的那台）上跑，
 * 不该再让对方准备 npm 安装环境。Node 是必然存在的（OpenClaw 自己是 Node 应用）。
 *
 * 配置全部走环境变量：
 *   OCS_BASE         OCS 机器的远程 API 地址，如 https://192.168.1.30:15320（必须 https）
 *   OCS_API_KEY      在 OCS 的「设置 → 远程 API」里生成的密钥
 *   OCS_CERT_SHA256  （建议）证书指纹固定。取 /health 里的 certFingerprint，形如 AB:CD:...
 *   OCS_TLS_STRICT   设 1 则走系统 CA 正常校验（只有换成正经证书时才需要）
 *   OCS_TIMEOUT_MS   单请求超时，默认 120000（启动类动作可能几分钟）
 *
 * ⚠️ 不设 OCS_CERT_SHA256 时默认**不校验**自签证书（局域网自用），并在 stderr 提醒一次。
 *    不校验意味着同网段的中间人可以拿到 API 密钥，所以指纹固定是推荐做法。
 */
import https from 'node:https';
import { URL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 显式关掉连接复用。
 *
 * Node 19 起全局 agent 默认开启 keepAlive，会带来两个坑（都踩过）：
 * 1. 复用连接意味着**不会重新握手**，`secureConnect` 不再触发，证书指纹检查被静默跳过；
 * 2. 保活的 socket 会一直吊着事件循环，`node ocs-watch.mjs --once` 这类一次性脚本不退出。
 * 这套工具调用频率很低，每次重新握手完全可以接受。
 */
const agent = new https.Agent({ keepAlive: false, maxSockets: 8 });

/** 读取并校验配置；缺关键项直接抛错，避免带着半个配置去调接口 */
export function loadConfig(env = process.env) {
	const base = (env.OCS_BASE || '').trim().replace(/\/+$/, '');
	const apiKey = (env.OCS_API_KEY || '').trim();
	const fingerprint = (env.OCS_CERT_SHA256 || '').trim();
	const strict = env.OCS_TLS_STRICT === '1';
	const timeoutMs = Number(env.OCS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

	if (!base) {
		throw new Error('缺少 OCS_BASE，例如 https://192.168.1.30:15320');
	}
	if (!/^https:\/\//i.test(base)) {
		throw new Error('OCS_BASE 必须以 https:// 开头：OCS 的远程 API 只提供 HTTPS');
	}
	if (!apiKey) {
		throw new Error('缺少 OCS_API_KEY：在 OCS 的「设置 → 远程 API」里生成一次，明文只显示那一次');
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error('OCS_TIMEOUT_MS 必须是正数');
	}

	return { base, apiKey, fingerprint, strict, timeoutMs };
}

/** 指纹比较：忽略大小写与冒号/空格等分隔符（Node 给的是 AB:CD:..，配置里可能写成别的形式） */
function normalizeFingerprint(value) {
	return String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

let warnedInsecure = false;

/** 发一个原始请求，返回 { status, headers, buffer, text } */
export function request(cfg, method, path, { query, body, timeoutMs } = {}) {
	const url = new URL(cfg.base + path);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== null && value !== '') {
				url.searchParams.set(key, String(value));
			}
		}
	}
	const limit = timeoutMs ?? cfg.timeoutMs;

	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
		const req = https.request(
			{
				method,
				hostname: url.hostname,
				port: url.port || 443,
				path: url.pathname + url.search,
				// 自签证书：只有显式要求严格校验时才让 Node 拒绝
				rejectUnauthorized: cfg.strict,
				timeout: limit,
				agent,
				headers: {
					'X-API-Key': cfg.apiKey,
					...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
				}
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					const buffer = Buffer.concat(chunks);
					resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer, text: buffer.toString('utf8') });
				});
			}
		);

		// 证书固定：在 TLS 握手完成、任何数据流动之前就把不匹配的连接掐掉
		req.on('socket', (socket) => {
			socket.on('secureConnect', () => {
				const actual = socket.getPeerCertificate?.()?.fingerprint256 || '';
				if (cfg.fingerprint) {
					if (normalizeFingerprint(actual) !== normalizeFingerprint(cfg.fingerprint)) {
						req.destroy(new Error(`证书指纹不匹配：配置 ${cfg.fingerprint}，实际 ${actual}`));
					}
					return;
				}
				if (!cfg.strict && !warnedInsecure) {
					warnedInsecure = true;
					console.error(
						'[ocs] 未校验服务器证书（自签证书）。建议把 /health 里的 certFingerprint 填进 OCS_CERT_SHA256。'
					);
				}
			});
		});

		req.on('timeout', () => req.destroy(new Error(`请求超时（${limit}ms）：${method} ${url.pathname}`)));
		req.on('error', reject);
		if (payload) {
			req.write(payload);
		}
		req.end();
	});
}

/**
 * 发请求并解包统一响应体。
 *
 * OCS 的响应体只有两种形状：成功 `{ data, requestId }`、失败 `{ error: { code, message } }`。
 * 失败时抛出的错误上带 `code` / `status`，调用方可据此区分「没权限」「正在跑」这类语义。
 */
export async function call(cfg, method, path, options) {
	const res = await request(cfg, method, path, options);
	let parsed;
	try {
		parsed = JSON.parse(res.text);
	} catch {
		throw new Error(`响应不是 JSON（HTTP ${res.status}）：${res.text.slice(0, 200)}`);
	}
	if (parsed && parsed.error) {
		const err = new Error(`[${parsed.error.code}] ${parsed.error.message}`);
		err.code = parsed.error.code;
		err.status = res.status;
		throw err;
	}
	return parsed ? parsed.data : undefined;
}

const encode = (value) => encodeURIComponent(String(value));

/** 接口封装：一一对应 OCS 远程 API 的路由 */
export const OcsApi = {
	health: (cfg) => call(cfg, 'GET', '/api/v1/health'),
	automationScripts: (cfg) => call(cfg, 'GET', '/api/v1/automation-scripts'),
	browsers: (cfg, query) => call(cfg, 'GET', '/api/v1/browsers', { query }),
	browser: (cfg, uid) => call(cfg, 'GET', `/api/v1/browsers/${encode(uid)}`),
	launch: (cfg, uid) => call(cfg, 'POST', `/api/v1/browsers/${encode(uid)}/launch`),
	close: (cfg, uid) => call(cfg, 'POST', `/api/v1/browsers/${encode(uid)}/close`),
	pages: (cfg, uid) => call(cfg, 'GET', `/api/v1/browsers/${encode(uid)}/pages`),
	logs: (cfg, uid, lines) => call(cfg, 'GET', `/api/v1/browsers/${encode(uid)}/logs`, { query: { lines } }),
	task: (cfg, taskId, waitSeconds) =>
		call(cfg, 'GET', `/api/v1/tasks/${encode(taskId)}`, { query: { wait: waitSeconds } }),
	addScripts: (cfg, uid, scripts) => call(cfg, 'POST', `/api/v1/browsers/${encode(uid)}/scripts`, { body: { scripts } }),
	removeScript: (cfg, uid, name) => call(cfg, 'DELETE', `/api/v1/browsers/${encode(uid)}/scripts/${encode(name)}`),

	/** 截图返回的是图片二进制，不走统一 JSON 响应体 */
	async screenshot(cfg, uid, opts = {}) {
		const res = await request(cfg, 'GET', `/api/v1/browsers/${encode(uid)}/screenshot`, { query: opts });
		if (res.status !== 200) {
			let message = `HTTP ${res.status}`;
			try {
				const parsed = JSON.parse(res.text);
				if (parsed && parsed.error) message = `[${parsed.error.code}] ${parsed.error.message}`;
			} catch {
				/* 保持 HTTP 状态码即可 */
			}
			throw new Error(`截图失败：${message}`);
		}
		const header = (name) => {
			const value = res.headers[name];
			return typeof value === 'string' ? value : '';
		};
		return {
			buffer: res.buffer,
			mimeType: header('content-type') || 'image/jpeg',
			pageUrl: decodeURIComponent(header('x-page-url')),
			pageTitle: decodeURIComponent(header('x-page-title'))
		};
	}
};
