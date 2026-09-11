import { ipcMain, BrowserWindow, WebContents, IpcMainInvokeEvent } from 'electron';
import crypto from 'crypto';
import { Logger } from '../../logger';

const logger = Logger('remote-api');

/** 渲染进程处理超时（它收到了请求但迟迟不回包） */
export class BridgeTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BridgeTimeoutError';
	}
}

/** 渲染进程不可用（尚未就绪、已崩溃、已重载） */
export class BridgeUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BridgeUnavailableError';
	}
}

/**
 * 反向 IPC 采用「渲染进程主动 lease（拉）」而不是「主进程 push」。
 *
 * push 模型的致命问题是时序：ipcRenderer.on 是懒注册的，渲染进程一旦重载，
 * 主进程缓存的就绪标志立刻失效，之后发出的消息全部石沉大海只能超时。
 * 改成渲染进程长轮询来拉，重载后新页面自然会重新 lease，主进程不需要维护
 * 任何「就绪标志」，并发上限也天然等于 lease 槽位数。
 */

const CH_LEASE = 'ocs-remote-api:lease';
const CH_COMPLETE = 'ocs-remote-api:complete';

/** 单次 lease 允许挂起的最长时间 */
const LEASE_HOLD_MS = 25 * 1000;
/**
 * 判定渲染进程「活跃」的时间窗口。
 * 必须大于 LEASE_HOLD_MS 并留出余量，否则健康检查会误报未就绪。
 */
const ACTIVE_WINDOW_MS = 35 * 1000;

interface PendingRequest {
	id: string;
	method: string;
	payload: unknown;
	/** 入队时的 generation，用于丢弃陈旧回包 */
	generation: number;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface Waiter {
	generation: number;
	resolve: (value: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** 已发出、等待渲染进程回包的请求 */
const pending = new Map<string, PendingRequest>();
/** 已就绪但因渲染进程未 lease 而积压的请求 */
const queue: PendingRequest[] = [];
/** 正在长轮询等待任务的渲染侧 lease */
const waiters: Waiter[] = [];

/**
 * 渲染进程世代号。每次渲染进程重载/崩溃自增。
 * 回包必须携带与当前一致的 generation 才会被采信，
 * 否则会出现「上一个页面的迟到结果结算了当前任务」。
 */
let generation = 0;
let lastLeaseAt = 0;
let targetWebContentsId: number | null = null;
let handlersRegistered = false;

/** 绑定渲染进程窗口。由 remoteRegister() 调用。 */
export function attachRendererWindow(win: BrowserWindow): void {
	targetWebContentsId = win.webContents.id;
	registerIpcHandlers();

	// 渲染进程重载或崩溃时，所有在飞请求必须立刻失败，不能继续等
	win.webContents.on('render-process-gone', (_e, details) => {
		logger.warn(`渲染进程意外退出: ${details.reason}，使所有在飞请求失效`);
		invalidateGeneration();
	});
	win.webContents.on('destroyed', () => {
		invalidateGeneration();
	});
	/**
	 * 主框架导航（含 reload）会让旧页面的 lease 循环消失，必须让世代失效。
	 *
	 * 这个事件的参数在不同 Electron 版本间不一致：旧版是位置参数
	 * (event, url, isInPlace, isMainFrame, ...)，新版改成单个 details 对象
	 * { url, isSameDocument, isMainFrame, ... }。两种都兼容——写死其中一种的话，
	 * 一旦签名变化整个 reload 安全机制会静默失灵（请求全部干等到超时）。
	 */
	win.webContents.on('did-start-navigation', (...args: any[]) => {
		const first = args[0];
		const isDetailsObject = Boolean(first && typeof first === 'object' && 'isMainFrame' in first);
		const isMainFrame = isDetailsObject ? first.isMainFrame : args[3];
		const isSameDocument = isDetailsObject ? first.isSameDocument : args[2];
		// 只关心真正的整页主框架导航。这个应用是 hash 路由，同文档导航会非常频繁，
		// 全部记录只会把日志淹掉
		if (isMainFrame && !isSameDocument) {
			logger.debug(
				`检测到主框架导航，使渲染进程世代失效（参数形态：${isDetailsObject ? 'details 对象' : '位置参数'}）`
			);
			invalidateGeneration();
		}
	});
}

function getRendererWebContents(): WebContents | null {
	if (targetWebContentsId === null) {
		return null;
	}
	// 不用 BrowserWindow.getAllWindows()[0]：服务器可能先于窗口创建，
	// 且 macOS 上 activate 可能重建窗口，[0] 未必是我们的窗口
	const win = BrowserWindow.getAllWindows().find((w) => w.webContents.id === targetWebContentsId);
	if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
		return null;
	}
	return win.webContents;
}

/** 渲染进程是否可用（最近有活跃的 lease） */
export function isRendererAvailable(): boolean {
	return Date.now() - lastLeaseAt < ACTIVE_WINDOW_MS;
}

/** 记录渲染进程上报的进度（不经过 lease 通道，渲染进程直接 send） */
export type ProgressReporter = (taskId: string, phase: string, message?: string) => void;
let progressReporter: ProgressReporter | null = null;

export function setProgressReporter(reporter: ProgressReporter): void {
	progressReporter = reporter;
}

/**
 * 渲染进程上报「当前有哪些 uid 在跑」时的对账回调。
 * 返回主进程判定出的孤儿 uid：曾经记录在跑、但渲染进程现在已经没有句柄的实例。
 */
export type RunningStateSyncer = (uids: string[]) => { orphans: string[] };
let runningStateSyncer: RunningStateSyncer | null = null;

export function setRunningStateSyncer(syncer: RunningStateSyncer): void {
	runningStateSyncer = syncer;
}

function invalidateGeneration(): void {
	generation++;
	lastLeaseAt = 0;
	// 这条日志很重要：渲染进程重载后 API 短暂不可用属于预期行为，
	// 记下来才能和「请求莫名其妙超时」区分开
	logger.warn(
		`渲染进程世代失效 => generation=${generation}，在飞请求 ${pending.size} 个，挂起 lease ${waiters.length} 个`
	);

	for (const req of pending.values()) {
		clearTimeout(req.timer);
		req.reject(new BridgeUnavailableError('渲染进程已重载或崩溃，请求已失效'));
	}
	pending.clear();

	/**
	 * 排队中的请求同样必须被拒绝。
	 * 之前这里只写了 queue.length = 0 —— 数组是清空了，但那些请求的 Promise
	 * 既不 resolve 也不 reject，调用方只能干等一整个超时（同步接口 30 秒）
	 * 才拿到一个含糊的失败，看起来就像服务卡死了。
	 */
	for (const req of queue.splice(0)) {
		clearTimeout(req.timer);
		req.reject(new BridgeUnavailableError('渲染进程已重载或崩溃，请求已失效'));
	}

	for (const waiter of waiters.splice(0)) {
		clearTimeout(waiter.timer);
		waiter.resolve(null);
	}
}

function assertSender(event: IpcMainInvokeEvent): void {
	if (targetWebContentsId === null || event.sender.id !== targetWebContentsId) {
		throw new Error('非法的调用来源');
	}
}

function toWire(req: PendingRequest) {
	return {
		id: req.id,
		method: req.method,
		payload: req.payload,
		generation: req.generation
	};
}

/** 把请求派发给正在等待的 lease；没有等待者就排队 */
function dispatch(req: PendingRequest): void {
	const index = waiters.findIndex((w) => w.generation === generation);
	if (index === -1) {
		queue.push(req);
		return;
	}
	const [waiter] = waiters.splice(index, 1);
	clearTimeout(waiter.timer);
	waiter.resolve(toWire(req));
}

function settle(req: PendingRequest, result: unknown): void {
	pending.delete(req.id);
	clearTimeout(req.timer);
	const wire = result as { data?: unknown; error?: { code?: string; message?: string } } | null;
	if (wire && typeof wire === 'object' && wire.error) {
		const err = new Error(wire.error.message || '渲染进程执行失败');
		err.name = wire.error.code || 'RendererError';
		(err as any).code = wire.error.code || 'RENDERER_ERROR';
		req.reject(err);
	} else {
		req.resolve(wire ? wire.data : undefined);
	}
}

function registerIpcHandlers(): void {
	if (handlersRegistered) {
		return;
	}
	handlersRegistered = true;

	ipcMain.handle(CH_LEASE, async (event) => {
		assertSender(event);
		lastLeaseAt = Date.now();
		const myGeneration = generation;

		const next = queue.shift();
		if (next) {
			if (next.generation !== generation) {
				// 陈旧请求，直接丢弃并让渲染进程再来一次
				clearTimeout(next.timer);
				next.reject(new BridgeUnavailableError('渲染进程已重载或崩溃，请求已失效'));
				return null;
			}
			return toWire(next);
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const index = waiters.findIndex((w) => w.timer === timer);
				if (index !== -1) {
					waiters.splice(index, 1);
				}
				resolve(null);
			}, LEASE_HOLD_MS);
			waiters.push({ generation: myGeneration, resolve, timer });
		});
	});

	ipcMain.handle(CH_COMPLETE, async (event, payload: any) => {
		assertSender(event);
		const id = payload?.id;
		const req = id ? pending.get(id) : undefined;
		if (!req) {
			return { ignored: true };
		}
		// 陈旧回包（来自上一个渲染进程世代）必须丢弃，
		// 否则旧页面的结果会错误地结算当前任务
		if (req.generation !== generation || payload?.generation !== generation) {
			return { ignored: true };
		}
		settle(req, payload?.result ?? null);
		return { ignored: false };
	});

	ipcMain.on('ocs-remote-api:progress', (event, payload: any) => {
		if (targetWebContentsId === null || event.sender.id !== targetWebContentsId) {
			return;
		}
		const taskId = payload?.taskId;
		if (typeof taskId !== 'string' || !progressReporter) {
			return;
		}
		progressReporter(taskId, String(payload?.phase ?? ''), payload?.message);
	});

	ipcMain.handle('ocs-remote-api:sync-running', async (event, uids: unknown) => {
		assertSender(event);
		const list = Array.isArray(uids) ? uids.filter((uid): uid is string => typeof uid === 'string') : [];
		if (!runningStateSyncer) {
			return { orphans: [] };
		}
		return runningStateSyncer(list);
	});
}

/**
 * 向渲染进程发起一次调用。
 *
 * @param timeoutMs 渲染进程迟迟不回包时的超时时间，超时抛 BridgeTimeoutError
 */
export function invokeRenderer<T = unknown>(
	method: string,
	payload: unknown,
	options: { timeoutMs: number }
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (!getRendererWebContents()) {
			reject(new BridgeUnavailableError('渲染进程尚未就绪'));
			return;
		}

		/**
		 * 快速失败：既没有正在等待的 lease，最近也没有 lease 活动，
		 * 说明渲染进程正在重载或已经不在轮询了，请求只会一直躺在队列里直到超时。
		 * 与其让调用方白等一整个超时（同步接口是 30 秒）才拿到一个含糊的 500，
		 * 不如立刻告诉它渲染进程不可用，让它带着 503 稍后重试。
		 */
		if (waiters.length === 0 && !isRendererAvailable()) {
			reject(new BridgeUnavailableError('渲染进程尚未就绪'));
			return;
		}

		const req: PendingRequest = {
			id: crypto.randomUUID(),
			method,
			payload,
			generation,
			resolve: resolve as (value: unknown) => void,
			reject,
			timer: undefined as unknown as ReturnType<typeof setTimeout>
		};

		req.timer = setTimeout(() => {
			pending.delete(req.id);
			reject(new BridgeTimeoutError('渲染进程响应超时'));
		}, options.timeoutMs);

		pending.set(req.id, req);
		dispatch(req);
	});
}
