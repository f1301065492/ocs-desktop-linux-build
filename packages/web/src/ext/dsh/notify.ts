import { store } from '../../store';
import { remote } from '../../utils/remote';

/**
 * 实时通知（渲染进程侧）。
 *
 * 浏览器子进程的 stdout/stderr 一到达渲染进程就调用这里，按 ~120ms 批量交给主进程；
 * 主进程统一做关键字过滤、与轮询链路共用去重表，再投递到 DSH。
 *
 * 这里不做关键字判断，避免两处规则漂移；也不接触 botId/targetId/密钥。
 */

interface DshNotifyEntry {
	name: string;
	line: string;
}

let queue: DshNotifyEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** 队列上限：异常刷屏时丢弃最旧的，避免内存无限增长 */
const QUEUE_LIMIT = 300;

/**
 * 上报一段子进程输出。
 * @param name 浏览器标签（与轮询链路的格式保持一致，便于去重）
 * @param chunk 原始输出（可能包含多行）
 */
export function notifyRealtime(name: string, chunk: unknown): void {
	const cfg = store.render?.setting?.dshNotify;
	if (!cfg?.enabled || !cfg.realtime || !cfg.botId || !cfg.targetId) {
		return;
	}
	const text = String(chunk ?? '');
	if (!text) {
		return;
	}
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (!lines.length) {
		return;
	}
	for (const line of lines) {
		queue.push({ name, line });
	}
	if (queue.length > QUEUE_LIMIT) {
		queue = queue.slice(-QUEUE_LIMIT);
	}
	if (timer) {
		return;
	}
	timer = setTimeout(() => {
		timer = null;
		const batch = queue.splice(0, queue.length);
		if (!batch.length) {
			return;
		}
		// 失败不打扰用户：轮询链路仍会兜底
		remote.methods.call('dshNotifyPush', { entries: batch }).catch(() => {});
	}, 120);
}
