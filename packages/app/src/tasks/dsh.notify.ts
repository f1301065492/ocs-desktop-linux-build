import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { app } from 'electron';
import { Logger } from '../logger';
import { bundledBridgeDir } from './dsh.bridge';

/**
 * 主动通知（OCS → DSH）。
 *
 * 设置页里填好 Bot ID / 目标 ID 后，由主进程拉起 `ocs-watch.mjs --loop --deliver dsh`，
 * 轮询 OCS 的日志与状态变化，经 DSH 的 IM 投递接口直接发到聊天——**不经过模型，零 token**。
 *
 * 进程归属于 OCS：窗口退出/应用退出时一并结束，不需要用户另开终端。
 */

let cachedLogger: ReturnType<typeof Logger> | null = null;
/** 延迟创建 logger：脱离 Electron 跑单测时没有 app，退回 console */
function getLogger(): ReturnType<typeof Logger> {
	if (!cachedLogger) {
		try {
			cachedLogger = Logger('dsh-notify');
		} catch {
			cachedLogger = console as unknown as ReturnType<typeof Logger>;
		}
	}
	return cachedLogger;
}

const MAX_LOG_LINES = 60;
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 3600;
const DEFAULT_DELIVERY_URL = 'http://127.0.0.1:3080/api/dsh-im/delivery/messages';
/** Bot/目标 ID 只允许非空白字符，避免拼进环境变量时出现奇怪内容 */
const ID_RE = /^\S{1,200}$/;

export interface DshNotifyInput {
	/** OCS 远程 API 地址，如 https://127.0.0.1:15320 */
	ocsBase: string;
	/** 远程 API 密钥明文 */
	apiKey: string;
	botId: string;
	targetId: string;
	/** 投递接口地址，留空用默认的 127.0.0.1:3080 */
	deliveryUrl?: string;
	/** 轮询间隔（秒） */
	intervalSec?: number;
}

export interface DshNotifyStatus {
	running: boolean;
	pid: number;
	startedAt: number;
	log: string[];
}

let child: ChildProcess | null = null;
let startedAt = 0;
let logLines: string[] = [];

function pushLine(line: string) {
	const text = String(line).trim();
	if (!text) {
		return;
	}
	const stamped = `${new Date().toISOString().slice(11, 19)} ${text}`;
	logLines.push(stamped);
	if (logLines.length > MAX_LOG_LINES) {
		logLines = logLines.slice(-MAX_LOG_LINES);
	}
}

function attachLines(stream: Readable | null, prefix = '') {
	if (!stream) {
		return;
	}
	let buffer = '';
	stream.on('data', (chunk: Buffer | string) => {
		buffer += chunk.toString();
		const parts = buffer.split(/\r?\n/);
		buffer = parts.pop() || '';
		for (const part of parts) {
			pushLine(prefix + part);
		}
	});
}

export function dshNotifyStatus(): DshNotifyStatus {
	return {
		running: Boolean(child),
		pid: child?.pid || 0,
		startedAt,
		log: logLines.slice(-12)
	};
}

function validate(input: DshNotifyInput): DshNotifyInput {
	const ocsBase = String(input?.ocsBase || '').trim();
	if (!/^https:\/\//i.test(ocsBase)) {
		throw new Error('OCS 地址必须以 https:// 开头');
	}
	const apiKey = String(input?.apiKey || '').trim();
	if (!apiKey) {
		throw new Error('缺少 API 密钥（远程 API 里生成的那串）');
	}
	const botId = String(input?.botId || '').trim();
	const targetId = String(input?.targetId || '').trim();
	if (!ID_RE.test(botId) || !ID_RE.test(targetId)) {
		throw new Error('Bot ID / 目标 ID 不能为空，且不能包含空白字符');
	}
	const rawInterval = Number(input?.intervalSec ?? 60);
	if (!Number.isInteger(rawInterval) || rawInterval < MIN_INTERVAL_SEC || rawInterval > MAX_INTERVAL_SEC) {
		throw new Error(`轮询间隔必须是 ${MIN_INTERVAL_SEC}–${MAX_INTERVAL_SEC} 秒之间的整数`);
	}
	const deliveryUrl = String(input?.deliveryUrl || '').trim();
	if (deliveryUrl && !/^https?:\/\//i.test(deliveryUrl)) {
		throw new Error('投递地址必须以 http(s):// 开头');
	}
	return { ocsBase, apiKey, botId, targetId, deliveryUrl, intervalSec: rawInterval };
}

/** 拉起常驻的 ocs-watch；重复调用会先停掉旧进程（幂等） */
export function startDshNotify(input: DshNotifyInput): DshNotifyStatus {
	const cfg = validate(input);
	stopDshNotify();

	const dir = bundledBridgeDir();
	const script = path.join(dir, 'ocs-watch.mjs');
	if (!fs.existsSync(script)) {
		throw new Error(`缺少通知脚本：${script}（安装包不完整？）`);
	}

	const env: Record<string, string | undefined> = {
		...process.env,
		// 用软件自带的 Electron 当 Node 跑，不要求系统装 Node
		ELECTRON_RUN_AS_NODE: '1',
		OCS_BASE: cfg.ocsBase,
		OCS_API_KEY: cfg.apiKey,
		DSH_BOT_ID: cfg.botId,
		DSH_TARGET_ID: cfg.targetId
	};
	if (cfg.deliveryUrl) {
		env.DSH_DELIVERY_URL = cfg.deliveryUrl;
	}

	logLines = [];
	startedAt = Date.now();
	pushLine(`启动通知监听（每 ${cfg.intervalSec}s，${cfg.ocsBase}）`);

	const proc = spawn(process.execPath, [script, '--loop', '--every', String(cfg.intervalSec), '--deliver', 'dsh'], {
		cwd: dir,
		env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child = proc;

	attachLines(proc.stdout);
	attachLines(proc.stderr, '[stderr] ');

	proc.on('error', (err) => {
		pushLine(`启动失败：${err.message}`);
		getLogger().error('通知进程启动失败', err);
		if (child === proc) {
			child = null;
		}
	});
	proc.on('exit', (code, signal) => {
		pushLine(`通知进程已退出（code=${code ?? '-'}，signal=${signal ?? '-'}）`);
		if (child === proc) {
			child = null;
		}
	});

	return dshNotifyStatus();
}

export function stopDshNotify(): DshNotifyStatus {
	if (child) {
		const proc = child;
		child = null;
		try {
			proc.kill('SIGTERM');
		} catch {
			// 已退出：忽略
		}
		pushLine('已停止通知监听');
	}
	return dshNotifyStatus();
}

/** 发一条测试消息到 DSH 投递接口（不依赖监听进程是否在跑） */
export async function testDshNotify(
	input: DshNotifyInput
): Promise<{ ok: boolean; response?: unknown; message?: string }> {
	const cfg = validate(input);
	const url = cfg.deliveryUrl || DEFAULT_DELIVERY_URL;
	try {
		const { data } = await axios.post(
			url,
			// DSH 的投递接口只接受 plain / markdown；早先写成 text 会被判 400
			{ botId: cfg.botId, targetId: cfg.targetId, text: 'OCS 通知通道测试', format: 'plain' },
			{ timeout: 8000 }
		);
		getLogger().info('通知测试已发送');
		return { ok: true, response: data };
	} catch (err) {
		const detail = (err as { response?: { data?: unknown } })?.response?.data;
		const message = err instanceof Error ? err.message : String(err);
		const suffix = detail === undefined ? '' : `：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
		getLogger().warn(`通知测试失败：${message}${suffix}`);
		return { ok: false, message: message + suffix };
	}
}

// 应用退出时结束子进程，避免留下孤儿。
// 对 `app` 做防御：脱离 Electron 主进程跑单测时 require('electron') 拿到的是路径字符串。
app?.on?.('will-quit', () => {
	stopDshNotify();
});
