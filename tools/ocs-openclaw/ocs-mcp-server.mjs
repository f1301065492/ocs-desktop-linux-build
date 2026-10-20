/**
 * OCS Desktop 的 MCP server（stdio，零依赖）。
 *
 * 作用：让 OpenClaw 的 agent 能"用飞书对话操作 OCS"——列浏览器、启动/关闭、看标签页、
 * 截图、读日志、查任务。挂上去之后，工具名是 `mcp_ocs_*`。
 *
 * 协议要点：
 * - stdio 传输是**按行分隔的 JSON-RPC 2.0**：一行一条消息，绝不能往 stdout 写别的东西
 *   （调试输出一律走 stderr），否则客户端解析直接崩。
 * - 只实现工具调用所需的最小子集：initialize / notifications/initialized / ping /
 *   tools/list / tools/call。
 *
 * 启动方式（由 OpenClaw 拉起，见 README）：
 *   OCS_BASE=https://192.168.1.30:15320 OCS_API_KEY=xxx node ocs-mcp-server.mjs
 */
import { loadConfig, OcsApi } from './ocs-client.mjs';

const SERVER_NAME = 'ocs-desktop';
const SERVER_VERSION = '1.0.0';

let cfg;
try {
	cfg = loadConfig();
} catch (err) {
	// 配置不全就没法干活，但仍要让客户端看到明确原因（stderr 会被 OpenClaw 收进日志）
	console.error(`[ocs-mcp] 配置错误：${err.message}`);
	process.exit(1);
}

const uidProp = { type: 'string', description: '浏览器 uid（用 ocs_list_browsers 拿）' };

const TOOLS = [
	{
		name: 'ocs_health',
		description:
			'检查 OCS 客户端是否在线：返回版本、远程 API 是否在监听、渲染进程是否就绪、证书指纹。任何操作失败时先调它。',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	},
	{
		name: 'ocs_list_browsers',
		description: '列出 OCS 里的浏览器（名称、uid、状态）。带 detailed 时附备注/标签/脚本名。',
		inputSchema: {
			type: 'object',
			properties: {
				running: { type: 'boolean', description: 'true 只看正在运行的，false 只看没在运行的，不传看全部' },
				clientToken: { type: 'string', description: '按创建时的幂等键过滤（通常用不到）' },
				detailed: { type: 'boolean', description: '带上备注、标签、自动化程序名（默认不带，省上下文）' }
			},
			additionalProperties: false
		}
	},
	{
		name: 'ocs_get_browser',
		description: '查单个浏览器的详情与实时状态。',
		inputSchema: { type: 'object', properties: { uid: uidProp }, required: ['uid'], additionalProperties: false }
	},
	{
		name: 'ocs_launch',
		description:
			'启动一个浏览器。启动过程包含用户脚本安装，可能要几分钟，所以默认只下发任务并返回 taskId；' +
			'想等一会儿就传 waitSeconds（建议 20 以内，避免工具调用超时），没跑完再用 ocs_task 继续查。',
		inputSchema: {
			type: 'object',
			properties: { uid: uidProp, waitSeconds: { type: 'number', description: '等待秒数，0 表示立刻返回 taskId（默认 0）' } },
			required: ['uid'],
			additionalProperties: false
		}
	},
	{
		name: 'ocs_close',
		description: '关闭一个浏览器。属于破坏性操作：执行前先跟用户确认。',
		inputSchema: { type: 'object', properties: { uid: uidProp }, required: ['uid'], additionalProperties: false }
	},
	{
		name: 'ocs_pages',
		description: '列出该浏览器当前打开的标签页（序号、URL、标题），可用于挑选截图目标。',
		inputSchema: { type: 'object', properties: { uid: uidProp }, required: ['uid'], additionalProperties: false }
	},
	{
		name: 'ocs_screenshot',
		description:
			'截取该浏览器某个标签页的画面（返回图片）。页面里的验证码弹窗等提示只能靠截图看，日志接口看不到。',
		inputSchema: {
			type: 'object',
			properties: {
				uid: uidProp,
				page: { type: 'string', description: '目标页 URL 的片段，不传则取最后一个标签页' },
				format: { type: 'string', enum: ['jpeg', 'png'], description: '默认 jpeg' },
				quality: { type: 'number', description: 'jpeg 质量 0-100，默认 70' },
				fullPage: { type: 'boolean', description: 'true 截整页' }
			},
			required: ['uid'],
			additionalProperties: false
		}
	},
	{
		name: 'ocs_logs',
		description:
			'读取该浏览器子进程的日志尾部（脚本安装、自动化程序上报的事件、报错等）。账号密码已被替换成 ***。' +
			'注意：浏览器没在运行、或已关闭时没有日志可读；页面里用户脚本画的提示（验证码弹窗、"章节全部完成"）不在日志里。',
		inputSchema: {
			type: 'object',
			properties: { uid: uidProp, lines: { type: 'number', description: '返回末尾多少行，默认 100，上限 1000' } },
			required: ['uid'],
			additionalProperties: false
		}
	},
	{
		name: 'ocs_task',
		description: '查询启动/关闭/重启任务的状态（启动类动作的最终结果在这里）。',
		inputSchema: {
			type: 'object',
			properties: {
				taskId: { type: 'string', description: 'ocs_launch / ocs_close 返回的 taskId' },
				waitSeconds: { type: 'number', description: '长轮询等待秒数，0-60，默认 0' }
			},
			required: ['taskId'],
			additionalProperties: false
		}
	},
	{
		name: 'ocs_add_script',
		description:
			'给浏览器追加一个自动化程序（如 "超星-手机密码登录"）。浏览器正在运行时 OCS 会自动重启它。' +
			'属于配置变更：执行前先跟用户确认，尤其要用 ocs_list_scripts 之类的信息核对脚本名。',
		inputSchema: {
			type: 'object',
			properties: {
				uid: uidProp,
				name: { type: 'string', description: '自动化程序名，取值见 ocs_automation_scripts' },
				configs: { type: 'object', description: '配置项键值，如 { phone, password }', additionalProperties: true }
			},
			required: ['uid', 'name'],
			additionalProperties: false
		}
	},
	{
		name: 'ocs_remove_script',
		description: '从浏览器移除一个自动化程序（浏览器在跑会自动重启）。破坏性操作，先跟用户确认。',
		inputSchema: {
			type: 'object',
			properties: { uid: uidProp, name: { type: 'string', description: '要移除的自动化程序名' } },
			required: ['uid', 'name'],
			additionalProperties: false
		}
	},
	{
		name: 'ocs_automation_scripts',
		description: '列出 OCS 内置的自动化程序及其配置项 schema（创建/追加脚本前先查有哪些键可填）。',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	}
];

/** 日志回给模型的字符上限：整段日志进上下文很贵，只留末尾（最新的在最后） */
const MAX_LOG_CHARS = 4000;

/**
 * 工具集：默认全量；设 `OCS_MCP_TOOLSET=basic` 只注册最常用的 8 个。
 *
 * 工具定义会随**每一轮**请求一起发给模型（实测全量约 3.6KB ≈ 1.3k token/轮），
 * 只做"看状态 / 启停 / 截图 / 看日志"的话用 basic，直接省掉另外几个工具的 schema。
 */
const BASIC_TOOL_NAMES = new Set([
	'ocs_health',
	'ocs_list_browsers',
	'ocs_get_browser',
	'ocs_launch',
	'ocs_close',
	'ocs_pages',
	'ocs_screenshot',
	'ocs_logs'
]);

const activeTools =
	(process.env.OCS_MCP_TOOLSET || 'full').toLowerCase() === 'basic'
		? TOOLS.filter((tool) => BASIC_TOOL_NAMES.has(tool.name))
		: TOOLS;

/**
 * 把接口返回整理成给模型看的紧凑文本。
 *
 * 一行一个浏览器，不换行、不重复字段名——这段文本会整段进模型的上下文，
 * 列表越长越值得省。备注/标签/脚本名单只在 detailed 时才带。
 */
function summarizeBrowsers(data, detailed = false) {
	const list = (data && data.browsers) || [];
	if (list.length === 0) {
		return '（没有浏览器实例）';
	}
	return list
		.map((item) => {
			const parts = [`${item.name ?? '(未命名)'} | uid=${item.uid} | ${item.status ?? '未知'}`];
			if (detailed) {
				const tags = (item.tags || []).map((t) => t.name).filter(Boolean);
				const scripts = (item.automationScripts || []).map((s) => s.name).filter(Boolean);
				if (tags.length) {
					parts.push(`标签: ${tags.join(',')}`);
				}
				if (scripts.length) {
					parts.push(`脚本: ${scripts.join(',')}`);
				}
				if (item.notes) {
					parts.push(`备注: ${item.notes}`);
				}
			}
			return parts.join(' | ');
		})
		.join('\n');
}

async function runTool(name, args = {}) {
	switch (name) {
		case 'ocs_health': {
			const data = await OcsApi.health(cfg);
			return [
				`OCS 版本 ${data.version}`,
				`远程 API 监听: ${data.listening ? '是' : '否'}`,
				`渲染进程就绪: ${data.rendererReady ? '是' : '否'}`,
				`可用地址: ${(data.addresses || []).join(', ') || '(无)'}`,
				`证书指纹: ${data.certFingerprint}`
			].join('\n');
		}
		case 'ocs_list_browsers': {
			const data = await OcsApi.browsers(cfg, { running: args.running, clientToken: args.clientToken });
			return summarizeBrowsers(data, Boolean(args.detailed));
		}
		case 'ocs_get_browser': {
			const data = await OcsApi.browser(cfg, args.uid);
			return summarizeBrowsers({ browsers: [data] }, true);
		}
		case 'ocs_launch': {
			const task = await OcsApi.launch(cfg, args.uid);
			const wait = Number(args.waitSeconds || 0);
			if (wait > 0) {
				const finished = await OcsApi.task(cfg, task.taskId, Math.min(60, Math.max(1, Math.round(wait))));
				return `已下发启动任务 taskId=${task.taskId}，等待 ${wait}s 后的状态：${finished.state}`;
			}
			return `已下发启动任务 taskId=${task.taskId}。用 ocs_task 查最终结果（启动含脚本安装，可能要几分钟）。`;
		}
		case 'ocs_close': {
			const task = await OcsApi.close(cfg, args.uid);
			return `已下发关闭任务 taskId=${task.taskId}。`;
		}
		case 'ocs_pages': {
			const pages = (await OcsApi.pages(cfg, args.uid)) || [];
			if (pages.length === 0) {
				return '（当前没有打开的标签页）';
			}
			return pages.map((p) => `#${p.index} ${p.title || '(无标题)'}\n   ${p.url}`).join('\n');
		}
		case 'ocs_screenshot': {
			const shot = await OcsApi.screenshot(cfg, args.uid, {
				page: args.page,
				format: args.format,
				quality: args.quality,
				fullPage: args.fullPage
			});
			return {
				content: [
					{ type: 'image', data: shot.buffer.toString('base64'), mimeType: shot.mimeType },
					{ type: 'text', text: `截图来源：${shot.pageTitle || '(无标题)'} ${shot.pageUrl}` }
				]
			};
		}
		case 'ocs_logs': {
			const data = await OcsApi.logs(cfg, args.uid, args.lines ?? 60);
			const head = `状态=${data.status} 行数=${data.lineCount} 被截断=${data.truncated ? '是' : '否'} 脱敏替换=${data.masked}`;
			let body = (data.text || '').trim();
			let note = '';
			// 日志可能很长，整段塞进上下文很贵：只留末尾 MAX_LOG_CHARS 个字符（最新的在最后）
			if (body.length > MAX_LOG_CHARS) {
				body = body.slice(-MAX_LOG_CHARS);
				note = `\n…（只保留末尾 ${MAX_LOG_CHARS} 字符，完整内容请直接查 OCS 的 /logs 接口）`;
			}
			return `${head}\n${body || '（日志为空：浏览器没在跑时读不到历史日志）'}${note}`;
		}
		case 'ocs_task': {
			const data = await OcsApi.task(cfg, args.taskId, args.waitSeconds);
			const detail = data.error ? ` 错误=${data.error.code || ''} ${data.error.message || ''}` : '';
			return `任务 ${data.taskId} 状态=${data.state} 动作=${data.action}${detail}`;
		}
		case 'ocs_add_script': {
			const result = await OcsApi.addScripts(cfg, args.uid, [{ name: args.name, configs: args.configs || {} }]);
			const restart = result && result.restart ? `（浏览器在运行，已自动重启：taskId=${result.restart.taskId}）` : '';
			return `已追加自动化程序「${args.name}」${restart}`;
		}
		case 'ocs_remove_script': {
			const result = await OcsApi.removeScript(cfg, args.uid, args.name);
			const restart = result && result.restart ? `（浏览器在运行，已自动重启：taskId=${result.restart.taskId}）` : '';
			return `已移除自动化程序「${args.name}」${restart}`;
		}
		case 'ocs_automation_scripts': {
			const data = await OcsApi.automationScripts(cfg);
			const scripts = (data && data.scripts) || [];
			return scripts
				.map((s) => {
					const keys = Object.keys(s.configs || {});
					const detail = keys
						.map((k) => {
							const item = s.configs[k] || {};
							return `${k}(${item.label || k}${item.required ? ',必填' : ''})`;
						})
						.join(', ');
					return `- ${s.name}${detail ? `：${detail}` : ''}`;
				})
				.join('\n');
		}
		default:
			throw new Error(`未知工具：${name}`);
	}
}

function write(message) {
	process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
	write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
	write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
	const { id, method, params } = message;

	// 通知（没有 id）不需要回包
	if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
		return;
	}

	switch (method) {
		case 'initialize':
			// 回客户端请求的协议版本：最小实现不挑版本，回自己的反而会让部分客户端直接断开
			return reply(id, {
				protocolVersion: params?.protocolVersion || '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
			});
		case 'ping':
			return reply(id, {});
		case 'tools/list':
			return reply(id, { tools: activeTools });
		case 'tools/call': {
			const name = params?.name;
			const args = params?.arguments || {};
			try {
				const result = await runTool(name, args);
				if (typeof result === 'string') {
					return reply(id, { content: [{ type: 'text', text: result }] });
				}
				return reply(id, result);
			} catch (err) {
				// 工具执行失败按 MCP 约定放在结果里（isError），而不是 JSON-RPC 错误——
				// 这样模型能看到失败原因并自己纠正
				const text = err && err.message ? err.message : String(err);
				return reply(id, { content: [{ type: 'text', text: `调用失败：${text}` }], isError: true });
			}
		}
		default:
			if (id !== undefined && id !== null) {
				return replyError(id, -32601, `不支持的方法：${method}`);
			}
	}
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) {
			continue;
		}
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			// 解析不了就没法回 id，只能记日志（不要污染 stdout）
			console.error('[ocs-mcp] 收到无法解析的消息行，已忽略');
			continue;
		}
		handle(message).catch((err) => {
			console.error(`[ocs-mcp] 处理失败：${err && err.stack ? err.stack : err}`);
			if (message && message.id !== undefined && message.id !== null) {
				replyError(message.id, -32603, '内部错误');
			}
		});
	}
});

process.stdin.on('end', () => process.exit(0));
console.error(`[ocs-mcp] ${SERVER_NAME} 已就绪，目标 ${cfg.base}`);
