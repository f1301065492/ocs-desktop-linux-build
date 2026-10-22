/**
 * OCS → 飞书 的信息推送（零依赖，Node 20+）。
 *
 * 它只做一件事：**发现有值得播报的新内容，就把要推送的文本打到 stdout**。
 * 交给谁发由 OpenClaw 的 delivery 决定——最省事的用法是挂成 OpenClaw 的
 * `cron --command` 任务，输出会被 announce 到飞书（见 README）。
 *
 * 播报内容：
 *   1. 浏览器状态变化（launched → closed / orphaned 等）
 *   2. 运行中浏览器的日志里**新增的关键行**（登录成功、需要人工处理验证码、报错…）
 *   3. OCS 从"连不上"恢复（连不上只在状态发生变化时提醒一次，避免每轮刷屏）
 *
 * 用法：
 *   node ocs-watch.mjs --once                 # 单次检查（cron --command 用这个）
 *   node ocs-watch.mjs --loop --every 30      # 自己按间隔轮询，常驻打印
 *
 * 参数：
 *   --once / --loop        单次 / 常驻（默认单次）
 *   --every <秒>           常驻模式的间隔，默认 30
 *   --lines <N>            每次每个浏览器拉多少行日志，默认 120
 *   --uid <uid>            只盯某一个浏览器
 *   --all                  不做关键字过滤，新增行全部播报
 *   --state <路径>         状态文件，默认 ~/.ocs-watch-state.json
 *   --reset                清空已读记录（重新基线，之后只报新内容）
 *
 * 环境变量：OCS_BASE / OCS_API_KEY / OCS_CERT_SHA256 / OCS_TLS_STRICT / OCS_TIMEOUT_MS
 *           OCS_WATCH_PATTERNS  用 | 分隔的正则，覆盖默认关键字
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffTail } from './tail-diff.mjs';
import { loadConfig, OcsApi } from './ocs-client.mjs';

/** 默认只播报这些：登录结果、验证码、失败与异常、初始化完成 */
const DEFAULT_PATTERNS = [
	'登录成功',
	'登录失败|密码错误|账号或密码',
	'需要人工|人工处理|人工输入',
	'验证码',
	'错误|失败|异常|超时',
	'初始化完成|浏览器已启动|已提交登录表单'
];

/** 每个浏览器保留多少行日志尾部，用于下一轮做增量比较 */
const TAIL_LIMIT = 120;

/** 状态机 → 中文（推送里不再出现 launched/closed 这类英文） */
const STATUS_TEXT = {
	launched: '运行中',
	launching: '启动中',
	closed: '已关闭',
	closing: '关闭中',
	orphaned: '失联'
};

function statusText(status) {
	const key = String(status || '').toLowerCase();
	return STATUS_TEXT[key] || status || '未知';
}

/** 去掉终端颜色控制符，避免推送里出现 \u001b[100m 之类的乱码 */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text) {
	return String(text || '').replace(ANSI_RE, '');
}

function parseArgs(argv) {
	const args = {
		once: true,
		loop: false,
		every: 30,
		lines: 120,
		all: false,
		uid: '',
		state: '',
		reset: false,
		/** 投递方式：stdout（默认，打到标准输出）/ dsh（POST 给 DSH-IM 主动投递接口）/ none */
		deliver: 'stdout',
		dshUrl: '',
		botId: '',
		targetId: ''
	};
	for (let i = 0; i < argv.length; i++) {
		const item = argv[i];
		if (item === '--loop') {
			args.loop = true;
			args.once = false;
		} else if (item === '--once') {
			args.once = true;
			args.loop = false;
		} else if (item === '--all') {
			args.all = true;
		} else if (item === '--reset') {
			args.reset = true;
		} else if (item === '--every') {
			args.every = Math.max(5, Number(argv[++i]) || 30);
		} else if (item === '--lines') {
			args.lines = Math.min(1000, Math.max(1, Number(argv[++i]) || 120));
		} else if (item === '--uid') {
			args.uid = String(argv[++i] || '');
		} else if (item === '--state') {
			args.state = String(argv[++i] || '');
		} else if (item === '--deliver') {
			args.deliver = String(argv[++i] || 'stdout').toLowerCase();
		} else if (item === '--dsh-url') {
			args.dshUrl = String(argv[++i] || '');
		} else if (item === '--bot-id') {
			args.botId = String(argv[++i] || '');
		} else if (item === '--target-id') {
			args.targetId = String(argv[++i] || '');
		}
	}
	if (!args.state) {
		args.state = path.join(os.homedir(), '.ocs-watch-state.json');
	}
	if (args.deliver === 'dsh') {
		// DSH-IM 的主动投递接口：在 DSH 的 Web 服务里，不经过模型 → 不花 token
		args.dshUrl = args.dshUrl || process.env.DSH_DELIVERY_URL || 'http://127.0.0.1:3080/api/dsh-im/delivery/messages';
		args.botId = args.botId || process.env.DSH_BOT_ID || '';
		args.targetId = args.targetId || process.env.DSH_TARGET_ID || '';
		if (!args.botId || !args.targetId) {
			console.error(
				'[ocs-watch] --deliver dsh 需要 DSH_BOT_ID / DSH_TARGET_ID（在 DSH 设置 → IM机器人 → 调用标识/新建目标里取），或用 --bot-id/--target-id 传入'
			);
			process.exit(2);
		}
	}
	return args;
}

/**
 * 把通知投递出去。
 *
 * `dsh` 走 DSH-IM 的主动投递 HTTP 接口：它跑在 DSH 的 Web 服务里，**不经过模型，不花 token**。
 * 失败只打到 stderr、绝不抛——一条通知丢了也不能把看门狗弄死。
 */
async function deliver(args, result) {
	const text = (result && result.text) || '';
	const entries = (result && result.entries) || [];
	if (args.deliver === 'none') {
		return;
	}
	if (args.deliver === 'parent') {
		// 交给父进程（OCS 主进程）统一去重后再投递：
		// 实时推送和轮询可能看到同一行，只有主进程能同时看到两边
		if (entries.length) {
			console.log('OCS_NOTIFY ' + JSON.stringify(entries));
		}
		return;
	}
	if (args.deliver !== 'dsh') {
		console.log(text);
		return;
	}
	try {
		const res = await fetch(args.dshUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ botId: args.botId, targetId: args.targetId, text, format: 'plain' })
		});
		const bodyText = await res.text();
		if (!res.ok) {
			console.error(`[ocs-watch] 投递失败 HTTP ${res.status}：${bodyText.slice(0, 200)}`);
		} else {
			console.error(`[ocs-watch] 已投递（${text.length} 字符）`);
		}
	} catch (err) {
		console.error(`[ocs-watch] 投递失败：${err && err.message ? err.message : err}`);
	}
}

function loadState(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { browsers: {}, lastError: '' };
		}
		if (!parsed.browsers || typeof parsed.browsers !== 'object' || Array.isArray(parsed.browsers)) {
			parsed.browsers = {};
		}
		// 旧版本用 seen（哈希数组），新版本用 tail（尾部行数组）。
		// 统一规范化，避免升级后旧进程/旧文件触发 undefined.length 之类的异常。
		for (const [uid, record] of Object.entries(parsed.browsers)) {
			if (!record || typeof record !== 'object' || Array.isArray(record)) {
				parsed.browsers[uid] = { status: '', tail: [] };
				continue;
			}
			if (!Array.isArray(record.tail)) {
				record.tail = [];
			}
			delete record.seen;
		}
		if (typeof parsed.lastError !== 'string') {
			parsed.lastError = '';
		}
		return parsed;
	} catch {
		return { browsers: {}, lastError: '' };
	}
}

function saveState(file, state) {
	try {
		fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
	} catch (err) {
		console.error(`[ocs-watch] 状态文件写入失败（不影响本次播报）：${err.message}`);
	}
}

/** 日志里形如 `[错误] 2026/10/15 10:52:40 \t 自动化脚本错误：...`，这里只按关键字筛，保留原样 */
function compilePatterns(env) {
	const custom = (env.OCS_WATCH_PATTERNS || '').trim();
	const list = custom ? custom.split('|') : DEFAULT_PATTERNS;
	return list.map((item) => new RegExp(item));
}

function interesting(line, patterns) {
	return patterns.some((re) => re.test(line));
}

/**
 * 检查一次。
 * @returns {{ text: string, hasNews: boolean, entries: { name: string, line: string }[] }}
 */
async function inspect(cfg, args, state, patterns) {
	const entries = [];

	const data = await OcsApi.browsers(cfg, {});
	const browsers = (data && data.browsers) || [];
	const currentUids = new Set(browsers.map((b) => b.uid));

	// 掉线的浏览器记录清掉，避免状态文件里堆一堆已经不存在的 uid
	for (const uid of Object.keys(state.browsers)) {
		if (!currentUids.has(uid)) {
			delete state.browsers[uid];
		}
	}

	for (const browser of browsers) {
		if (args.uid && browser.uid !== args.uid) {
			continue;
		}
		const record = state.browsers[browser.uid] || (state.browsers[browser.uid] = { status: '', tail: [] });
		const label = `${browser.name || '(未命名)'} [${String(browser.uid).slice(0, 8)}]`;

		// 1. 状态变化：第一次见到只记基线，不播报（否则装上就刷一轮）
		if (record.status && record.status !== browser.status) {
			entries.push({
				name: label,
				line: `状态：${statusText(record.status)} → ${statusText(browser.status)}`
			});
		}
		record.status = browser.status;

		// 2. 运行中的浏览器看新增日志
		if (browser.status !== 'launched') {
			continue;
		}
		let log;
		try {
			log = await OcsApi.logs(cfg, browser.uid, args.lines);
		} catch (err) {
			entries.push({ name: label, line: `读日志失败：${err.message}` });
			continue;
		}
		const text = (log && log.text) || '';
		if (!text) {
			continue;
		}
		const currTail = text
			.split('\n')
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean)
			.slice(-TAIL_LIMIT);
		const prevTail = Array.isArray(record.tail) ? record.tail : [];
		// 首次见到这个浏览器：只记基线，不播报历史内容
		const isFirstPass = prevTail.length === 0;
		let fresh = [];
		if (!isFirstPass) {
			// 按「尾部增量」而不是「整行哈希」判断新增：
			// 同样的错误文本再次出现时也算一条新事件，不会被永久吞掉
			for (const line of diffTail(prevTail, currTail)) {
				if (args.all || interesting(line, patterns)) {
					fresh.push(line);
				}
			}
		}
		record.tail = currTail;
		// 旧版本状态文件里的字段，顺手清掉
		delete record.seen;
		// 日志被清空/重置时可能一次多出很多行，限制单轮播报条数
		if (fresh.length > 20) {
			fresh = fresh.slice(-20);
		}
		if (fresh.length) {
			for (const line of fresh) {
				entries.push({ name: label, line });
			}
		}
	}

	// 按浏览器分组拼成可读文本（stdout / 直接投递 DSH 时用）
	const grouped = new Map();
	for (const entry of entries) {
		if (!grouped.has(entry.name)) {
			grouped.set(entry.name, []);
		}
		grouped.get(entry.name).push(entry.line);
	}
	const body = [...grouped]
		.map(([name, items]) => `${name}\n${items.map((item) => `  · ${item}`).join('\n')}`)
		.join('\n');
	return { text: body ? `【OCS 提醒】\n${body}` : '', hasNews: Boolean(body), entries };
}

async function runOnce(cfg, args, patterns) {
	const state = loadState(args.state);
	if (args.reset) {
		state.browsers = {};
	}

	let result;
	try {
		result = await inspect(cfg, args, state, patterns);
		state.lastError = '';
	} catch (err) {
		// 连不上：只在「从正常变成连不上」时提醒一次，恢复时再提醒一次
		const message = err && err.message ? err.message : String(err);
		// 把堆栈打到 stderr：一次性的代码异常也有据可查（设置页「最近输出」会采集）
		console.error(`[ocs-watch] 本轮检查异常：${err && err.stack ? err.stack : message}`);
		if (state.lastError !== message) {
			state.lastError = message;
			saveState(args.state, state);
			return {
				text: `【OCS 提醒】\n连不上 OCS（${cfg.base}）：${message}`,
				hasNews: true,
				entries: [{ name: '', line: `连不上 OCS（${cfg.base}）：${message}` }]
			};
		}
		saveState(args.state, state);
		return { text: '', hasNews: false, entries: [] };
	}

	if (state.lastError) {
		// 上一轮是失败、这轮成功了：播报恢复
		const recovered = `已恢复与 OCS（${cfg.base}）的连接`;
		state.lastError = '';
		saveState(args.state, state);
		const entries = [{ name: '', line: recovered }, ...((result && result.entries) || [])];
		return {
			text: result.hasNews
				? `【OCS 提醒】\n${recovered}\n${result.text.replace(/^【OCS 提醒】\n?/, '')}`
				: `【OCS 提醒】\n${recovered}`,
			hasNews: true,
			entries
		};
	}

	saveState(args.state, state);
	return result;
}

const args = parseArgs(process.argv.slice(2));
const patterns = compilePatterns(process.env);

let cfg;
try {
	cfg = loadConfig();
} catch (err) {
	console.error(`[ocs-watch] 配置错误：${err.message}`);
	process.exit(1);
}

if (args.loop) {
	console.error(`[ocs-watch] 常驻模式，每 ${args.every}s 检查一次，目标 ${cfg.base}，投递方式 ${args.deliver}`);
	// 常驻模式：空的时候不投递任何东西，避免刷屏
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			const result = await runOnce(cfg, args, patterns);
			if (result.hasNews) {
				// stdout 模式带时间戳方便看日志；投递到聊天时用原文（时间平台会显示）
				const payload =
					args.deliver === 'stdout' ? { ...result, text: `${new Date().toLocaleString()} ${result.text}` } : result;
				await deliver(args, payload);
			}
		} catch (err) {
			console.error(`[ocs-watch] 本轮检查异常：${err && err.message ? err.message : err}`);
		}
		await new Promise((resolve) => setTimeout(resolve, args.every * 1000));
	}
} else {
	const result = await runOnce(cfg, args, patterns);
	if (result.hasNews) {
		await deliver(args, result);
	} else if (args.deliver === 'stdout') {
		// OpenClaw 对 HEARTBEAT_OK 会跳过播报，用它表示「这轮没什么可说的」
		console.log('HEARTBEAT_OK');
	}
}
