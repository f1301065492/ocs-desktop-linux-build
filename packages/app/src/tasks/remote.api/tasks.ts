import crypto from 'crypto';
import { Logger } from '../../logger';
import { getRemoteApiConfig } from './config';
import { invokeRenderer, BridgeTimeoutError, BridgeUnavailableError } from './bridge';
import { broadcast } from './events';

const logger = Logger('remote-api');

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'unknown';
export type TaskKind = 'launch' | 'close';
export type TaskPhase =
	| 'queued'
	| 'precheck'
	| 'checking-scripts'
	| 'installing-scripts'
	| 'launching'
	| 'launched'
	| 'closing'
	| 'closed';

export interface RemoteTask {
	taskId: string;
	kind: TaskKind;
	uid: string;
	clientToken?: string;
	state: TaskState;
	phase: TaskPhase;
	message?: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	error?: { code: string; message: string };
	result?: unknown;
}

const TERMINAL_STATES: TaskState[] = ['succeeded', 'failed', 'timeout', 'unknown'];

/** 终态任务在内存中的保留时长 */
const TERMINAL_TTL_MS = 30 * 60 * 1000;
/** 任务表容量上限，超出后淘汰最旧的终态任务 */
const MAX_TASKS = 1000;

const tasks = new Map<string, RemoteTask>();
/** uid -> 进行中的 taskId，用于 per-uid 互斥 */
const inflightByUid = new Map<string, string>();
/** 超过并发上限时的等待队列（元素为 taskId） */
const queue: string[] = [];

export function isTerminal(state: TaskState): boolean {
	return TERMINAL_STATES.includes(state);
}

function runningLaunchCount(): number {
	let count = 0;
	for (const task of tasks.values()) {
		if (task.kind === 'launch' && task.state === 'running') {
			count++;
		}
	}
	return count;
}

/** 回收过期/超量的终态任务，防止长期运行内存膨胀 */
function recycle(): void {
	const now = Date.now();
	for (const [id, task] of tasks) {
		if (isTerminal(task.state) && task.finishedAt && now - task.finishedAt > TERMINAL_TTL_MS) {
			tasks.delete(id);
		}
	}
	if (tasks.size > MAX_TASKS) {
		const finished = [...tasks.values()]
			.filter((task) => isTerminal(task.state))
			.sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
		for (const task of finished) {
			if (tasks.size <= MAX_TASKS) break;
			tasks.delete(task.taskId);
		}
	}
}

/** 该 uid 是否已有进行中的任务 */
export function getInflightTaskId(uid: string): string | undefined {
	const taskId = inflightByUid.get(uid);
	if (!taskId) return undefined;
	const task = tasks.get(taskId);
	// 任务已被回收但锁没释放时视为无人在跑
	if (!task) {
		inflightByUid.delete(uid);
		return undefined;
	}
	return taskId;
}

function pump(): void {
	const limit = Math.max(1, getRemoteApiConfig().maxConcurrentLaunches);
	while (queue.length > 0) {
		const nextId = queue[0];
		const task = tasks.get(nextId);
		if (!task || task.state !== 'queued') {
			queue.shift();
			continue;
		}
		// 并发上限只约束启动；关闭应立即执行，不能被排队拖住
		if (task.kind === 'launch' && runningLaunchCount() >= limit) {
			break;
		}
		queue.shift();
		// execute 内部已有 try/catch/finally，这里再兜一层防止意外 rejection 变成未捕获异常
		execute(task).catch((err) => logger.error(`任务 ${task.taskId} 执行异常: ${String(err)}`));
	}
}

/**
 * 创建并调度一个任务。
 * 调用方需先用 getInflightTaskId(uid) 判断互斥。
 */
export function createTask(kind: TaskKind, uid: string, clientToken?: string): RemoteTask {
	recycle();
	const task: RemoteTask = {
		taskId: crypto.randomUUID(),
		kind,
		uid,
		clientToken,
		state: 'queued',
		phase: 'queued',
		createdAt: Date.now()
	};
	tasks.set(task.taskId, task);
	inflightByUid.set(uid, task.taskId);
	queue.push(task.taskId);
	pump();
	return task;
}

/** 把任务的当前状态推给所有 SSE 客户端 */
function broadcastTask(task: RemoteTask): void {
	broadcast('task', {
		taskId: task.taskId,
		kind: task.kind,
		uid: task.uid,
		state: task.state,
		phase: task.phase,
		message: task.message,
		error: task.error
	});
}

async function execute(task: RemoteTask): Promise<void> {
	task.state = 'running';
	task.startedAt = Date.now();
	task.phase = task.kind === 'launch' ? 'precheck' : 'closing';
	broadcastTask(task);

	const config = getRemoteApiConfig();
	const timeoutMs = task.kind === 'launch' ? config.launchTimeoutMs : config.closeTimeoutMs;

	try {
		const result = await invokeRenderer(
			task.kind === 'launch' ? 'browser.launch' : 'browser.close',
			{ taskId: task.taskId, uid: task.uid },
			{ timeoutMs }
		);
		task.state = 'succeeded';
		task.phase = task.kind === 'launch' ? 'launched' : 'closed';
		task.result = result;
	} catch (err) {
		if (err instanceof BridgeTimeoutError) {
			/**
			 * 超时不等于失败。超时那一刻浏览器可能已经真的起来了，
			 * 只是 launched 事件没等到、或还卡在安装脚本。
			 * 报 failed 会诱导调用方重试并产生重复启动，所以如实报 timeout。
			 */
			task.state = 'timeout';
			task.error = {
				code: task.kind === 'launch' ? 'LAUNCH_TIMEOUT' : 'CLOSE_TIMEOUT',
				message: '操作超时，实际结果未知。请调用 GET /api/v1/browsers/:uid 复核状态，勿盲目重试'
			};
		} else if (err instanceof BridgeUnavailableError) {
			task.state = 'unknown';
			task.error = { code: 'RENDERER_UNAVAILABLE', message: err.message };
		} else {
			// 渲染进程回传的结构化错误码（如 ALREADY_RUNNING / EXECUTABLE_PATH_NOT_SET）
			const code = (err as { code?: unknown })?.code;
			task.state = 'failed';
			task.error = {
				code: typeof code === 'string' && code ? code : 'INTERNAL',
				message: err instanceof Error ? err.message : String(err)
			};
		}
		logger.warn(`任务 ${task.taskId} [${task.kind} ${task.uid}] 结束: ${task.state}`);
	} finally {
		task.finishedAt = Date.now();
		inflightByUid.delete(task.uid);
		// 终态统一广播，覆盖 succeeded / failed / timeout / unknown 所有分支
		broadcastTask(task);
		pump();
	}
}

export function getTask(taskId: string): RemoteTask | undefined {
	return tasks.get(taskId);
}

export function listTasks(): RemoteTask[] {
	return [...tasks.values()];
}

/** 由渲染进程上报的进度更新 */
export function setTaskProgress(taskId: string, phase: string, message?: string): void {
	const task = tasks.get(taskId);
	if (!task || isTerminal(task.state)) {
		return;
	}
	task.phase = phase as TaskPhase;
	if (message) {
		task.message = message;
	}
	// 让盯着事件流的调用方也能看到阶段推进，而不是只能轮询
	broadcastTask(task);
}

/**
 * 有界长轮询：等待任务进入终态或超时。
 * 让调用方一次请求就能拿到结果，不必自己写轮询循环。
 */
export async function waitForTask(taskId: string, maxWaitMs: number): Promise<RemoteTask | undefined> {
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		const task = tasks.get(taskId);
		if (!task || isTerminal(task.state) || Date.now() >= deadline) {
			return task;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
