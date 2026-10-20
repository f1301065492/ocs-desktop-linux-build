/**
 * 测试用的「假 OCS」：用自签证书起一个 HTTPS 服务，实现远程 API 里这套脚本会用到的路由。
 *
 * 只服务测试，不实现任何业务逻辑——它存在的意义是让 ocs-client / ocs-mcp-server /
 * ocs-watch 能在本机被真跑一遍（而不是靠肉眼看代码）。
 */
import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** 1×1 的透明 PNG，够用来验证截图链路 */
const TINY_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);

/** 与应用里 fingerprintOf() 一致：DER 的 sha256，大写冒号分隔十六进制 */
export function fingerprintOfPem(certPem) {
	const body = certPem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)[1];
	const der = Buffer.from(body.replace(/\s+/g, ''), 'base64');
	return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
}

function envelope(data) {
	return JSON.stringify({ data, requestId: 'test' });
}

function fail(res, status, code, message) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: { code, message }, requestId: 'test' }));
}

export async function startMockOcs({ certPem, keyPem, apiKey }) {
	const state = {
		errorLogs: [],
		browsers: [
			{
				uid: 'aaaaaaaa111122223333444455556666',
				name: '未命名浏览器 (1)',
				status: 'launched',
				notes: '测试用',
				tags: [{ name: '自动', color: '#165dff' }],
				automationScripts: [{ name: '智慧树-手机密码登录' }]
			},
			{
				uid: 'bbbbbbbb111122223333444455556666',
				name: '未命名浏览器',
				status: 'closed',
				notes: '',
				tags: [],
				automationScripts: []
			}
		],
		logs: {
			aaaaaaaa111122223333444455556666: '智慧树：开始手机密码登录\n账号 *** 登录失败，密码 *** 错误\n'
		}
	};

	const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
		const url = new URL(req.url, 'https://localhost');
		const path = url.pathname;

		if (path === '/api/v1/health') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				envelope({
					ok: true,
					version: '2.13.6-test',
					listening: true,
					rendererReady: true,
					certFingerprint: fingerprintOfPem(certPem),
					addresses: ['127.0.0.1']
				})
			);
			return;
		}

		if (req.headers['x-api-key'] !== apiKey) {
			fail(res, 401, 'UNAUTHORIZED', '密钥错误');
			return;
		}

		const match = path.match(/^\/api\/v1\/browsers\/([^/]+)(\/logs|\/screenshot|\/launch|\/pages)?$/);
		if (path === '/api/v1/browsers') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(envelope({ browsers: state.browsers, total: state.browsers.length }));
			return;
		}
		const taskMatch = path.match(/^\/api\/v1\/tasks\/(.+)$/);
		if (taskMatch) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(envelope({ taskId: taskMatch[1], state: 'succeeded', action: 'launch' }));
			return;
		}
		if (!match) {
			fail(res, 404, 'BROWSER_NOT_FOUND', `未知接口: ${path}`);
			return;
		}

		const uid = decodeURIComponent(match[1]);
		const action = match[2] || '';
		const browser = state.browsers.find((item) => item.uid === uid);
		if (!browser) {
			fail(res, 404, 'BROWSER_NOT_FOUND', `浏览器不存在: ${uid}`);
			return;
		}

		if (!action) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(envelope(browser));
			return;
		}
		if (action === '/logs') {
			const text = state.logs[uid] || '';
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				envelope({
					text,
					lineCount: text ? text.split('\n').length - 1 : 0,
					truncated: false,
					status: browser.status,
					masked: 2
				})
			);
			return;
		}
		if (action === '/screenshot') {
			res.writeHead(200, {
				'Content-Type': 'image/png',
				'Content-Length': String(TINY_PNG.length),
				'X-Page-Url': encodeURIComponent('https://www.zhihuishu.com/'),
				'X-Page-Title': encodeURIComponent('智慧树网')
			});
			res.end(TINY_PNG);
			return;
		}
		if (action === '/pages') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(envelope([{ index: 0, url: 'http://localhost:15319/index.html', title: '书签' }]));
			return;
		}
		if (action === '/launch') {
			res.writeHead(202, { 'Content-Type': 'application/json' });
			res.end(envelope({ taskId: 'task-1', uid, state: 'queued' }));
			return;
		}
		fail(res, 404, 'BROWSER_NOT_FOUND', `未知接口: ${path}`);
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();

	return {
		port,
		base: `https://127.0.0.1:${port}`,
		state,
		/** 追加日志（模拟浏览器又输出了新内容） */
		appendLog(uid, text) {
			state.logs[uid] = (state.logs[uid] || '') + text;
		},
		setStatus(uid, status) {
			const browser = state.browsers.find((item) => item.uid === uid);
			if (browser) {
				browser.status = status;
			}
		},
		close: () => new Promise((resolve) => server.close(resolve))
	};
}

/** 生成一份自签证书（用 openssl；Git for Windows 自带） */
export function ensureTestCert(dir) {
	const certPath = `${dir}/cert.pem`;
	const keyPath = `${dir}/key.pem`;
	if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
		return { certPath, keyPath };
	}
	const candidates = [
		'openssl',
		'C:/Program Files/Git/usr/bin/openssl.exe',
		'C:/Program Files/Git/mingw64/bin/openssl.exe',
		'/usr/bin/openssl'
	];
	let lastError = null;
	for (const bin of candidates) {
		try {
			execFileSync(
				bin,
				[
					'req',
					'-x509',
					'-newkey',
					'rsa:2048',
					'-nodes',
					'-keyout',
					keyPath,
					'-out',
					certPath,
					'-days',
					'2',
					'-subj',
					'/CN=127.0.0.1',
					'-addext',
					'subjectAltName=IP:127.0.0.1'
				],
				{ stdio: 'ignore' }
			);
			return { certPath, keyPath };
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(`生成测试证书失败（需要 openssl，Git for Windows 自带）：${lastError && lastError.message}`);
}
