/**
 * /ocs —— DSH 斜杠命令：直接调用 OCS 远程 API，不经过模型、零 token。
 *
 * DSH 的命令 handler 在本地执行，结果直接渲染到聊天里（command/done），
 * 不会进入模型上下文。命令名受 DSH 限制必须是 `[a-z][a-z0-9_-]*`，
 * 所以固定用 `/ocs`；子指令和参数全部支持中文。
 *
 * 配置（cordis.patch.yml 里的 config）：
 *   base             OCS 远程 API 地址，如 https://127.0.0.1:15320
 *   apiKey           远程 API 密钥
 *   certFingerprint  自签证书的 SHA-256 指纹（建议填，空则不校验）
 */

import https from 'node:https';

export const name = 'ocs-command';
export const inject = ['commands'];

const SHORT_UID = 8;
const MAX_LOG_CHARS = 6000;

const HELP = [
	'/ocs 帮助                    显示本帮助',
	'/ocs 列表                    浏览器列表（名称 / uid / 状态）',
	'/ocs 查看 <名称|uid>          单个浏览器详情（不显示账号密码）',
	'/ocs 日志 <名称|uid> [行数]   最近日志（默认 60 行，已脱敏）',
	'/ocs 启动 <名称|uid>          启动浏览器（返回任务 ID）',
	'/ocs 关闭 <名称|uid>          关闭浏览器（返回任务 ID）',
	'/ocs 任务 <任务ID>            查询异步任务结果',
	'/ocs 健康                    远程 API 健康状态',
	'',
	'说明：命令在本地执行，不经过模型、零 token；uid 可只写前 6 位。'
].join('\n');

/** 英文/中文子指令别名 → 规范动词 */
const VERBS = new Map(
	Object.entries({
		帮助: 'help',
		h: 'help',
		help: 'help',
		'?': 'help',
		'？': 'help',
		列表: 'list',
		列举: 'list',
		浏览器: 'list',
		list: 'list',
		ls: 'list',
		查看: 'get',
		详情: 'get',
		get: 'get',
		info: 'get',
		show: 'get',
		日志: 'logs',
		记录: 'logs',
		logs: 'logs',
		log: 'logs',
		启动: 'launch',
		打开: 'launch',
		开始: 'launch',
		launch: 'launch',
		start: 'launch',
		关闭: 'close',
		停止: 'close',
		关掉: 'close',
		close: 'close',
		stop: 'close',
		任务: 'task',
		结果: 'task',
		task: 'task',
		健康: 'health',
		状态: 'health',
		health: 'health'
	})
);

function normalizeFingerprint(value) {
	return String(value || '')
		.replace(/[^0-9a-fA-F]/g, '')
		.toUpperCase();
}

function shortUid(uid) {
	return String(uid || '').slice(0, SHORT_UID);
}

function truncate(text, limit = MAX_LOG_CHARS) {
	const value = String(text || '');
	if (value.length <= limit) {
		return value;
	}
	return `…（前面已省略 ${value.length - limit} 字符）\n${value.slice(-limit)}`;
}

function unwrapBrowserList(data) {
	if (Array.isArray(data)) {
		return data;
	}
	if (data && Array.isArray(data.browsers)) {
		return data.browsers;
	}
	return [];
}

export function apply(ctx, config = {}) {
	// 关闭连接复用与 TLS 会话缓存：会话票据恢复会让 getPeerCertificate 拿不到证书，
	// 指纹固定会误判（与 tools/ocs-openclaw/ocs-client.mjs 的教训一致）
	const agent = new https.Agent({ keepAlive: false, maxSockets: 4, maxCachedSessions: 0 });
	const base = String(config.base || '')
		.trim()
		.replace(/\/+$/, '');
	const apiKey = String(config.apiKey || '').trim();
	const fingerprint = String(config.certFingerprint || '').trim();

	function request(method, pathname, { body, timeoutMs = 15000 } = {}) {
		return new Promise((resolve, reject) => {
			if (!base || !apiKey) {
				reject(new Error('插件未配置 base / apiKey，请检查 cordis.patch.yml 里的 ocs-command 配置'));
				return;
			}
			const url = new URL(base + pathname);
			const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
			const req = https.request(
				{
					method,
					hostname: url.hostname,
					port: url.port || 443,
					path: url.pathname + url.search,
					agent,
					rejectUnauthorized: false,
					timeout: timeoutMs,
					headers: {
						'X-API-Key': apiKey,
						...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
					}
				},
				(res) => {
					const chunks = [];
					res.on('data', (chunk) => chunks.push(chunk));
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						let json;
						try {
							json = text ? JSON.parse(text) : undefined;
						} catch {
							json = undefined;
						}
						if (res.statusCode && res.statusCode >= 400) {
							const detail = json && json.error ? `${json.error.code}: ${json.error.message}` : `HTTP ${res.statusCode}`;
							reject(new Error(detail));
							return;
						}
						if (json && json.error) {
							reject(new Error(`${json.error.code}: ${json.error.message}`));
							return;
						}
						resolve(json ? json.data : undefined);
					});
				}
			);
			req.on('socket', (socket) => {
				socket.on('secureConnect', () => {
					if (!fingerprint) {
						return;
					}
					const actual = socket.getPeerCertificate?.()?.fingerprint256 || '';
					if (!actual || normalizeFingerprint(actual) !== normalizeFingerprint(fingerprint)) {
						req.destroy(new Error('OCS 证书指纹不匹配（检查 certFingerprint）'));
					}
				});
			});
			req.on('timeout', () => req.destroy(new Error(`请求超时：${method} ${pathname}`)));
			req.on('error', reject);
			if (payload) {
				req.write(payload);
			}
			req.end();
		});
	}

	async function resolveBrowser(selector) {
		const query = String(selector || '').trim();
		if (!query) {
			throw new Error('请提供浏览器名称或 uid，例如：/ocs 日志 测试');
		}
		const list = unwrapBrowserList(await request('GET', '/api/v1/browsers'));
		const wanted = query.toLowerCase();
		const byUid = list.filter((item) => String(item.uid || '').toLowerCase() === wanted);
		if (byUid.length === 1) {
			return byUid[0];
		}
		const byPrefix = list.filter((item) => String(item.uid || '').toLowerCase().startsWith(wanted));
		if (byPrefix.length === 1) {
			return byPrefix[0];
		}
		if (byPrefix.length > 1) {
			throw new Error(
				`uid 前缀「${query}」匹配到多台：${byPrefix.map((item) => `${item.name}[${shortUid(item.uid)}]`).join('、')}`
			);
		}
		const byName = list.filter((item) => String(item.name || '').toLowerCase() === wanted);
		if (byName.length === 1) {
			return byName[0];
		}
		if (byName.length > 1) {
			throw new Error(`名称「${query}」匹配到多台，请改用 uid：${byName.map((item) => shortUid(item.uid)).join('、')}`);
		}
		const byContains = list.filter((item) => String(item.name || '').toLowerCase().includes(wanted));
		if (byContains.length === 1) {
			return byContains[0];
		}
		if (byContains.length > 1) {
			throw new Error(
				`名称包含「${query}」的有 ${byContains.length} 台：${byContains
					.map((item) => `${item.name}[${shortUid(item.uid)}]`)
					.join('、')}`
			);
		}
		throw new Error(`找不到匹配的浏览器：${query}`);
	}

	async function doList() {
		const list = unwrapBrowserList(await request('GET', '/api/v1/browsers'));
		if (!list.length) {
			return '（没有浏览器）';
		}
		const running = list.filter((item) => item.status === 'launched').length;
		const lines = [`共 ${list.length} 台，运行中 ${running} 台`];
		for (const item of list) {
			lines.push(`- ${item.name || '(未命名)'} [${shortUid(item.uid)}] ${item.status || 'unknown'}`);
		}
		return lines.join('\n');
	}

	async function doGet(selector) {
		const summary = await resolveBrowser(selector);
		const browser = (await request('GET', `/api/v1/browsers/${encodeURIComponent(summary.uid)}`)) || summary;
		const lines = [`${browser.name || '(未命名)'} [${shortUid(browser.uid)}]`, `状态：${browser.status || 'unknown'}`];
		if (browser.tags) {
			const tags = Array.isArray(browser.tags) ? browser.tags.join('、') : String(browser.tags);
			lines.push(`标签：${tags || '（无）'}`);
		}
		if (browser.notes) {
			lines.push(`备注：${browser.notes}`);
		}
		if (Array.isArray(browser.automationScripts) && browser.automationScripts.length) {
			lines.push(
				`自动化程序：${browser.automationScripts
					.map((item) => (typeof item === 'string' ? item : item?.name || item?.id || '?'))
					.join('、')}`
			);
		}
		return lines.join('\n');
	}

	async function doLogs(selector, linesArg) {
		const browser = await resolveBrowser(selector);
		const requested = Math.min(200, Math.max(1, Number(linesArg) || 60));
		const data = await request(
			'GET',
			`/api/v1/browsers/${encodeURIComponent(browser.uid)}/logs?lines=${requested}`
		);
		const text = (data && data.text) || '（没有日志）';
		return `日志（${browser.name || '(未命名)'} [${shortUid(browser.uid)}]）：\n${truncate(text)}`;
	}

	async function doLaunch(selector) {
		const browser = await resolveBrowser(selector);
		const data = await request('POST', `/api/v1/browsers/${encodeURIComponent(browser.uid)}/launch`, {
			body: {},
			timeoutMs: 30000
		});
		const taskId = data && data.taskId ? data.taskId : '';
		return [
			`已提交启动：${browser.name || '(未命名)'} [${shortUid(browser.uid)}]`,
			taskId ? `任务 ID：${taskId}（用 /ocs 任务 ${taskId} 查看结果）` : '（接口未返回任务 ID）'
		].join('\n');
	}

	async function doClose(selector) {
		const browser = await resolveBrowser(selector);
		const data = await request('POST', `/api/v1/browsers/${encodeURIComponent(browser.uid)}/close`, {
			body: {},
			timeoutMs: 30000
		});
		const taskId = data && data.taskId ? data.taskId : '';
		return [
			`已提交关闭：${browser.name || '(未命名)'} [${shortUid(browser.uid)}]`,
			taskId ? `任务 ID：${taskId}（用 /ocs 任务 ${taskId} 查看结果）` : '（接口未返回任务 ID）'
		].join('\n');
	}

	async function doTask(taskId) {
		const id = String(taskId || '').trim();
		if (!id) {
			throw new Error('请提供任务 ID，例如：/ocs 任务 abc123');
		}
		const data = await request('GET', `/api/v1/tasks/${encodeURIComponent(id)}`);
		if (!data) {
			return '任务无数据';
		}
		const lines = [`任务 ${data.taskId || id}`, `类型：${data.type || '?'}`, `状态：${data.state || '?'}`];
		if (data.error) {
			lines.push(`错误：${typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error)}`);
		}
		if (data.result !== undefined) {
			lines.push(`结果：${truncate(JSON.stringify(data.result), 1500)}`);
		}
		return lines.join('\n');
	}

	async function doHealth() {
		const data = (await request('GET', '/api/v1/health')) || {};
		return [
			`版本：${data.version || '?'}`,
			`远程 API：${data.listening ? '监听中' : '未监听'}｜渲染进程：${data.rendererReady ? '就绪' : '未就绪'}`,
			`证书指纹：${data.certFingerprint || '（无）'}`,
			`地址：${(data.addresses || []).join(', ') || '（无）'}`
		].join('\n');
	}

	async function handler(invocation) {
		const raw = String(invocation.rawInput || '').trim();
		const parts = raw.split(/\s+/).filter(Boolean);
		const verb = VERBS.get((parts[0] || '').toLowerCase()) || (parts[0] ? '' : 'help');
		try {
			switch (verb) {
				case 'help':
					return { kind: 'success', text: HELP };
				case 'list':
					return { kind: 'success', text: await doList() };
				case 'get':
					return { kind: 'success', text: await doGet(parts[1]) };
				case 'logs':
					return { kind: 'success', text: await doLogs(parts[1], parts[2]) };
				case 'launch':
					return { kind: 'success', text: await doLaunch(parts[1]) };
				case 'close':
					return { kind: 'success', text: await doClose(parts[1]) };
				case 'task':
					return { kind: 'success', text: await doTask(parts[1]) };
				case 'health':
					return { kind: 'success', text: await doHealth() };
				default:
					return {
						kind: 'error',
						text: `不认识的子指令：${parts[0] || '（空）'}\n\n${HELP}`
					};
			}
		} catch (err) {
			if (invocation.signal?.aborted) {
				return { kind: 'error', text: '已取消' };
			}
			return { kind: 'error', text: err instanceof Error ? err.message : String(err) };
		}
	}

	ctx.effect(
		() =>
			ctx.commands.register({
				name: 'ocs',
				description: '查看 / 控制 OCS 浏览器（本地调用 API，不经过模型，零 token）',
				input: { hint: '输入「帮助」查看子指令' },
				handler
			}),
		'ocs-command'
	);
}
