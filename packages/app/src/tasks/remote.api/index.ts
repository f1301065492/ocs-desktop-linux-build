import express, { Request, Response, NextFunction } from 'express';
import https from 'https';
import crypto from 'crypto';
import { app } from 'electron';
import { Logger } from '../../logger';
import { getRemoteApiConfig, getRemoteApiPublicConfig } from './config';
import { ApiError, fail, ok, toApiError } from './errors';
import { requireApiKey } from './auth';
import { parseCreateBrowserInput, parseUid, parseClientTokenFilter, parseWaitSeconds, parseQuality } from './validate';
import { createTask, getInflightTaskId, getTask, setTaskProgress, waitForTask } from './tasks';
import {
	attachRendererWindow,
	invokeRenderer,
	isRendererAvailable,
	setProgressReporter,
	setRunningStateSyncer,
	BridgeTimeoutError,
	BridgeUnavailableError,
	RunningSnapshotItem
} from './bridge';
import { store } from '../../store';
import { AutomationScripts } from '../../scripts';
import { ensureTlsMaterial, listLocalAddresses } from './tls';
import { addClient, removeClient, broadcast, closeAllClients } from './events';

const logger = Logger('remote-api');

/** 创建 / 查询这类纯内存操作的超时（毫秒） */
const FAST_OP_TIMEOUT = 30 * 1000;

let server: https.Server | null = null;
let listening = false;
let lastError: string | null = null;
let fingerprint = '';
let initialized = false;

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

/** Express 4 不会自动捕获 async handler 的 rejection，需要手动转发给错误中间件 */
function asyncRoute(handler: AsyncHandler) {
	return (req: Request, res: Response, next: NextFunction) => {
		handler(req, res).catch(next);
	};
}

function requestIdOf(req: Request): string {
	return (req as Request & { requestId?: string }).requestId ?? '';
}

function ensureRenderer(): void {
	if (!isRendererAvailable()) {
		throw new ApiError('RENDERER_UNAVAILABLE', '渲染进程尚未就绪，请稍后重试');
	}
}

/**
 * 把 bridge 与渲染进程抛出的异常统一翻译成对外错误码。
 * 渲染进程回传的结构化 code 直接透传（如 ALREADY_RUNNING / EXECUTABLE_PATH_NOT_SET）。
 */
function translateRendererError(err: unknown): ApiError {
	if (err instanceof BridgeUnavailableError) {
		return new ApiError('RENDERER_UNAVAILABLE', err.message);
	}
	if (err instanceof BridgeTimeoutError) {
		// 渲染进程收下了请求却迟迟不回包，对调用方而言与「不可用」等价。
		// 返回可重试的 503 而不是 500，否则调用方会以为是自己的请求有问题。
		return new ApiError('RENDERER_UNAVAILABLE', '渲染进程响应超时，请稍后重试');
	}
	const code = (err as { code?: unknown })?.code;
	const message = err instanceof Error ? err.message : String(err);
	if (typeof code === 'string' && code) {
		return new ApiError(code as ApiError['code'], message);
	}
	return new ApiError('INTERNAL', message);
}

function createApp(): express.Express {
	const expressApp = express();

	// 1. requestId + 访问日志
	// 刻意只记录方法/路径/状态/耗时：请求体里装着用户脚本的账号密码，
	// 请求头里有 API 密钥，两者都不能进日志
	expressApp.use((req, res, next) => {
		const requestId = crypto.randomUUID();
		(req as Request & { requestId?: string }).requestId = requestId;
		res.setHeader('X-Request-Id', requestId);

		const startedAt = Date.now();
		res.on('finish', () => {
			logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms [${requestId}]`);
		});
		next();
	});

	// 2. body 解析（比主服务的 10mb 小得多）
	expressApp.use(express.json({ limit: '256kb' }));

	// 3. JSON 解析失败要返回结构化错误，而不是 Express 默认的 HTML 错误页
	expressApp.use((err: any, req: Request, res: Response, next: NextFunction) => {
		if (err && err.type === 'entity.parse.failed') {
			res.status(400).json(fail(new ApiError('INVALID_JSON', '请求体不是合法的 JSON'), requestIdOf(req)));
			return;
		}
		if (err && err.type === 'entity.too.large') {
			res.status(400).json(fail(new ApiError('INVALID_ARGUMENT', '请求体过大'), requestIdOf(req)));
			return;
		}
		next(err);
	});

	// 4. 健康检查不鉴权：调用方需要它来判断服务是否可达、密钥是否需要更换
	expressApp.get('/api/v1/health', (req, res) => {
		res.json(
			ok(
				{
					ok: true,
					version: app.getVersion(),
					panel: getRemoteApiPublicConfig(),
					listening,
					rendererReady: isRendererAvailable(),
					certFingerprint: fingerprint,
					addresses: listLocalAddresses()
				},
				requestIdOf(req)
			)
		);
	});

	// 5. 其余全部需要 API 密钥
	const api = express.Router();
	api.use((req, res, next) => {
		requireApiKey(req, res, next).catch(next);
	});

	/**
	 * 列出可用的自动化程序及其配置项 schema。
	 * 没有这个接口，调用方无从知道该传哪些 name、哪些 configs 键，创建接口等于不可用。
	 */
	api.get('/automation-scripts', (req, res) => {
		// 自动化程序注册表本来就在主进程（内置脚本在启动时加载），直接读，不必绕渲染进程
		const scripts = JSON.parse(JSON.stringify(AutomationScripts)) as Array<{
			name: string;
			icon?: string;
			configs?: Record<string, unknown>;
		}>;
		res.json(
			ok(
				{
					scripts: scripts.map((script) => ({
						name: script.name,
						icon: script.icon ?? null,
						// 配置项的 label / type / options 就是调用方能填的键与取值说明
						configs: script.configs ?? {}
					})),
					total: scripts.length
				},
				requestIdOf(req)
			)
		);
	});

	api.post(
		'/browsers',
		asyncRoute(async (req, res) => {
			ensureRenderer();
			const input = parseCreateBrowserInput(req.body ?? {});
			try {
				const result = await invokeRenderer<{ created: boolean; browser: unknown }>('browser.create', input, {
					timeoutMs: FAST_OP_TIMEOUT
				});
				// 幂等命中已有浏览器时返回 200，新建返回 201
				res.status(result.created ? 201 : 200).json(ok(result, requestIdOf(req)));
			} catch (err) {
				throw translateRendererError(err);
			}
		})
	);

	api.get(
		'/browsers',
		asyncRoute(async (req, res) => {
			ensureRenderer();
			const clientToken = parseClientTokenFilter(req.query.clientToken);
			const parentUid = req.query.parentUid ? parseUid(req.query.parentUid) : undefined;
			const running = req.query.running === undefined ? undefined : String(req.query.running).toLowerCase() === 'true';
			try {
				const result = await invokeRenderer(
					'browser.list',
					{ clientToken, parentUid, running },
					{
						timeoutMs: FAST_OP_TIMEOUT
					}
				);
				res.json(ok(result, requestIdOf(req)));
			} catch (err) {
				throw translateRendererError(err);
			}
		})
	);

	api.get(
		'/browsers/:uid',
		asyncRoute(async (req, res) => {
			ensureRenderer();
			const uid = parseUid(req.params.uid);
			try {
				const result = await invokeRenderer('browser.get', { uid }, { timeoutMs: FAST_OP_TIMEOUT });
				if (!result) {
					throw new ApiError('BROWSER_NOT_FOUND', `浏览器不存在: ${uid}`);
				}
				res.json(ok(result, requestIdOf(req)));
			} catch (err) {
				throw translateRendererError(err);
			}
		})
	);

	api.post(
		'/browsers/:uid/launch',
		asyncRoute(async (req, res) => {
			ensureRenderer();
			const uid = parseUid(req.params.uid);

			// 同步前置检查：把「不存在」「已在运行」这类错误尽早暴露成明确的 HTTP 状态，
			// 而不是让调用方拿到一个 202 之后再从任务里读到失败
			const browser = await getBrowserOrThrow(uid);
			const status = (browser as { status?: string }).status;
			if (status === 'launching' || status === 'launched' || status === 'closing') {
				throw new ApiError('ALREADY_RUNNING', `浏览器 ${uid} 已在运行或正在启动中`);
			}

			const inflight = getInflightTaskId(uid);
			if (inflight) {
				throw new ApiError('BROWSER_BUSY', `浏览器 ${uid} 已有进行中的任务: ${inflight}`);
			}

			const task = createTask('launch', uid);
			res.status(202).json(ok({ taskId: task.taskId, uid, state: task.state }, requestIdOf(req)));
		})
	);

	api.post(
		'/browsers/:uid/close',
		asyncRoute(async (req, res) => {
			ensureRenderer();
			const uid = parseUid(req.params.uid);

			const browser = await getBrowserOrThrow(uid);
			const status = (browser as { status?: string }).status;
			if (status === 'closed' || status === 'orphaned') {
				throw new ApiError('NOT_RUNNING', `浏览器 ${uid} 当前未在运行`);
			}

			const inflight = getInflightTaskId(uid);
			if (inflight) {
				throw new ApiError('BROWSER_BUSY', `浏览器 ${uid} 已有进行中的任务: ${inflight}`);
			}

			const task = createTask('close', uid);
			res.status(202).json(ok({ taskId: task.taskId, uid, state: task.state }, requestIdOf(req)));
		})
	);

	api.get(
		'/tasks/:taskId',
		asyncRoute(async (req, res) => {
			const taskId = String(req.params.taskId);
			const waitSeconds = parseWaitSeconds(req.query.wait);
			const task = waitSeconds > 0 ? await waitForTask(taskId, waitSeconds * 1000) : getTask(taskId);
			if (!task) {
				throw new ApiError(
					'TASK_NOT_FOUND',
					'任务不存在。任务表不持久化，应用重启后请用 clientToken 调用 GET /api/v1/browsers 复核'
				);
			}
			res.json(ok(task, requestIdOf(req)));
		})
	);

	/** 列出某个浏览器当前打开的所有标签页，便于调用方决定截哪一页 */
	api.get(
		'/browsers/:uid/pages',
		asyncRoute(async (req, res) => {
			ensureRenderer();
			const uid = parseUid(req.params.uid);
			await getBrowserOrThrow(uid);
			try {
				const result = await invokeRenderer('browser.pages', { uid }, { timeoutMs: FAST_OP_TIMEOUT });
				res.json(ok(result, requestIdOf(req)));
			} catch (err) {
				throw translateRendererError(err);
			}
		})
	);

	/**
	 * 截取页面画面。
	 *
	 * 成功时返回**图片二进制**而不是 JSON 信封——这样才能直接丢进 <img src> 或
	 * 保存成文件用图片查看器打开。失败时仍返回标准的 JSON 错误体。
	 */
	api.get(
		'/browsers/:uid/screenshot',
		asyncRoute(async (req, res) => {
			ensureRenderer();
			const uid = parseUid(req.params.uid);
			await getBrowserOrThrow(uid);

			const format = req.query.format === 'png' ? 'png' : 'jpeg';
			const quality = parseQuality(req.query.quality);
			const pageUrl = typeof req.query.page === 'string' && req.query.page ? req.query.page : undefined;
			const fullPage = String(req.query.fullPage ?? '').toLowerCase() === 'true';

			let shot: { base64: string; mimeType: string; size: number; url: string; title: string };
			try {
				shot = await invokeRenderer(
					'browser.screenshot',
					{ uid, pageUrl, format, quality, fullPage },
					{ timeoutMs: FAST_OP_TIMEOUT }
				);
			} catch (err) {
				throw translateRendererError(err);
			}

			res.setHeader('Content-Type', shot.mimeType);
			res.setHeader('Content-Length', String(shot.size));
			// 把画面来源一并回传，调用方据此确认截到的是哪个标签页
			// （标题可能是中文，必须编码后放进 header）
			res.setHeader('X-Page-Url', encodeURIComponent(shot.url));
			res.setHeader('X-Page-Title', encodeURIComponent(shot.title));
			// 画面是瞬时的，别让中间层缓存
			res.setHeader('Cache-Control', 'no-store');
			res.send(Buffer.from(shot.base64, 'base64'));
		})
	);

	/**
	 * SSE 事件流：浏览器状态变化与任务状态变化会实时推送。
	 *
	 * 鉴权支持 ?apiKey=，因为浏览器的 EventSource 无法自定义请求头。
	 */
	api.get(
		'/events',
		asyncRoute(async (req, res) => {
			// 立刻冲刷响应头，否则调用方要等到第一条业务数据才知道连接已经建立
			res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
			res.setHeader('Cache-Control', 'no-cache, no-transform');
			res.setHeader('Connection', 'keep-alive');
			// 反向代理默认会缓冲响应，那样 SSE 就失去实时性了
			res.setHeader('X-Accel-Buffering', 'no');
			res.flushHeaders?.();

			res.write(`event: ready\ndata: ${JSON.stringify({ requestId: requestIdOf(req) })}\n\n`);
			addClient(res);

			req.on('close', () => {
				removeClient(res);
			});
		})
	);

	expressApp.use('/api/v1', api);

	// 6. 未匹配的任何路径
	expressApp.use((req, res) => {
		res
			.status(404)
			.json(fail(new ApiError('BROWSER_NOT_FOUND', `未知接口: ${req.method} ${req.path}`), requestIdOf(req)));
	});

	// 7. 兜底错误处理：绝不把栈或绝对路径回传给调用方
	expressApp.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
		const apiErr = err instanceof ApiError ? err : toApiError(err);
		if (apiErr.code === 'INTERNAL') {
			logger.error(`未处理异常 [${requestIdOf(req)}]: ${err instanceof Error ? err.stack : String(err)}`);
		}
		if (res.headersSent) {
			return;
		}
		res.status(apiErr.status).json(fail(apiErr, requestIdOf(req)));
	});

	return expressApp;
}

/** 上一次广播出去的状态，用于只推真正变化的条目，避免每次上报都刷全量 */
const lastStatusByUid = new Map<string, string>();

/**
 * 渲染进程上报运行清单时的对账与广播。
 *
 * 渲染进程重载会清空它的 processes 表，但 child_process.fork 出来的浏览器子进程
 * 仍在运行。只有靠主进程这份持久化记录才能发现它们已经失去句柄，
 * 从而如实报 orphaned —— 谎报 closed 会让调用方误以为可以重新启动，
 * 而实际上 Chromium 的 profile 锁会让新实例起不来。
 */
function syncRunningState(snapshot: RunningSnapshotItem[], freshSession: boolean): { orphans: string[] } {
	const previous = store.store.remoteApiRunning?.uids ?? [];
	const currentUids = snapshot.map((item) => item.uid);
	const currentSet = new Set(currentUids);
	const orphans = previous.filter((uid) => !currentSet.has(uid));
	store.set('remoteApiRunning', { uids: currentUids });

	// 新出现或状态发生变化的
	for (const { uid, status } of snapshot) {
		if (lastStatusByUid.get(uid) !== status) {
			lastStatusByUid.set(uid, status);
			broadcast('status', { uid, status });
		}
	}

	// 从上报里消失的：渲染进程刚重建视图时意味着失去句柄的孤儿，
	// 常规上报里则只是被正常关闭了
	for (const uid of previous) {
		if (currentSet.has(uid)) {
			continue;
		}
		lastStatusByUid.delete(uid);
		broadcast('status', { uid, status: freshSession ? 'orphaned' : 'closed' });
	}

	return { orphans };
}

async function getBrowserOrThrow(uid: string): Promise<unknown> {
	try {
		const browser = await invokeRenderer('browser.get', { uid }, { timeoutMs: FAST_OP_TIMEOUT });
		if (!browser) {
			throw new ApiError('BROWSER_NOT_FOUND', `浏览器不存在: ${uid}`);
		}
		return browser;
	} catch (err) {
		if (err instanceof ApiError) {
			throw err;
		}
		throw translateRendererError(err);
	}
}

/** 启动远程 API。失败只记日志并记录状态，绝不上抛——否则会拖垮启动流程 */
export async function startRemoteApi(): Promise<void> {
	if (!initialized) {
		initialized = true;
		// 渲染进程上报的进度统一落到任务表
		setProgressReporter(setTaskProgress);
		// 渲染进程上报运行清单时做孤儿对账
		setRunningStateSyncer(syncRunningState);
	}

	const config = getRemoteApiConfig();
	if (!config.enabled) {
		logger.info('远程 API 未开启，跳过启动');
		return;
	}
	if (server) {
		return;
	}
	if (!config.keySalt || !config.keyHash) {
		listening = false;
		lastError = '未配置 API 密钥';
		logger.warn('远程 API 已开启但尚未配置密钥，拒绝启动');
		return;
	}

	try {
		const tls = await ensureTlsMaterial();
		fingerprint = tls.fingerprint;

		const instance = https.createServer({ key: tls.key, cert: tls.cert }, createApp());
		server = instance;

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			instance.once('error', onError);
			instance.listen(config.port, config.bindAddress, () => {
				instance.removeListener('error', onError);
				resolve();
			});
		});

		// 运行期错误只记录，不能让进程崩掉
		instance.on('error', (err) => {
			logger.error(`远程 API 运行期错误: ${err.message}`);
		});

		listening = true;
		lastError = null;
		logger.info(`远程 API 已启动 => https://${config.bindAddress}:${config.port}（证书指纹 ${fingerprint}）`);
	} catch (err) {
		server = null;
		listening = false;
		lastError = err instanceof Error ? err.message : String(err);
		logger.error(`远程 API 启动失败: ${lastError}`);
	}
}

/** 停止远程 API */
export async function stopRemoteApi(): Promise<void> {
	const instance = server;
	if (!instance) {
		listening = false;
		return;
	}
	server = null;
	listening = false;
	// SSE 是长连接，不主动断开的话 close() 会一直等它们
	closeAllClients();
	await new Promise<void>((resolve) => {
		instance.close(() => resolve());
		// 已建立的 keep-alive 连接会一直拖住 close()，必须主动断开，
		// 否则 restartRemoteApi() 会永久挂起。
		// @types/node 停留在 17.x 尚未声明该方法（Node 18.2+ 才有），
		// 但 Electron 35 内置的是 Node 22，运行期一定存在。
		(instance as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
	});
}

/** 重启远程 API，用于设置变更后立即生效 */
export async function restartRemoteApi(): Promise<void> {
	await stopRemoteApi();
	await startRemoteApi();
}

/** 供设置页展示的运行状态 */
export function getRemoteApiStatus() {
	return {
		...getRemoteApiPublicConfig(),
		listening,
		lastError,
		certFingerprint: fingerprint,
		rendererReady: isRendererAvailable(),
		addresses: listLocalAddresses()
	};
}

export { attachRendererWindow };
