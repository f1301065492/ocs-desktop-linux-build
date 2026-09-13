import { watch } from 'vue';
import { electron, inBrowser } from './node';
import { remote } from './remote';
import { store } from '../store';
import { root, Folder } from '../fs/folder';
import { Browser } from '../fs/browser';
import { Process, processes } from './process';
import { newBrowser } from './browser';
import { persistBrowserTree } from './persist';
import { RawAutomationScript } from '../components/automation-scripts';

const { ipcRenderer } = electron;

/**
 * 远程 API 的渲染侧执行器。
 *
 * 采用「渲染进程主动 lease（长轮询拉取）」而不是「主进程 push」：
 * 主进程 push 有致命的时序问题——ipcRenderer.on 是懒注册的，渲染进程一旦重载，
 * 主进程缓存的就绪标志就失效，之后发的消息全部石沉大海。改成渲染进程来拉，
 * 重载后新页面自然会重新 lease，主进程不需要维护任何就绪状态。
 */

/** 并发 lease 槽位数，同时也是渲染侧的并发上限 */
const LEASE_SLOTS = 3;

const CH_LEASE = 'ocs-remote-api:lease';
const CH_COMPLETE = 'ocs-remote-api:complete';
const CH_PROGRESS = 'ocs-remote-api:progress';
const CH_SYNC_RUNNING = 'ocs-remote-api:sync-running';

/** 被判定为孤儿（主进程记录在跑，但渲染进程已失去句柄）的 uid */
let orphanedUids = new Set<string>();
/** 本次会话是否已完成孤儿对账（只在启动后的第一次上报做） */
let reconciledThisSession = false;
let started = false;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造带错误码的异常，错误码会被序列化后传给主进程作为对外错误码 */
function apiError(code: string, message: string): Error {
	const err = new Error(message);
	(err as { code?: string }).code = code;
	return err;
}

function serializeError(err: unknown): { code: string; message: string } {
	const code = (err as { code?: unknown })?.code;
	return {
		code: typeof code === 'string' && code ? code : 'INTERNAL',
		message: err instanceof Error ? err.message : String(err)
	};
}

/**
 * 保证回包是纯 JSON。
 * 结构里只要混进 Vue 响应式代理、Process 实例或 ChildProcess，
 * 主进程的 structured clone 就会直接抛 "An object could not be cloned"。
 */
function toPlain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value ?? null));
}

function reportProgress(taskId: string | undefined, phase: string, message?: string) {
	if (!taskId) return;
	ipcRenderer.send(CH_PROGRESS, { taskId, phase, message });
}

/** 把浏览器实体投影成可安全过 IPC 的纯对象 */
function serializeBrowser(browser: Browser) {
	return {
		uid: browser.uid,
		name: browser.name,
		parentUid: browser.parent,
		notes: browser.notes,
		tags: (browser.tags ?? []).map((tag) => ({ name: tag.name, color: tag.color })),
		cachePath: browser.cachePath,
		createTime: browser.createTime,
		automationScripts: (browser.automationScripts ?? []).map((script) => ({
			name: script.name,
			configs: script.configs ?? null
		})),
		status: statusOf(browser.uid),
		remoteMeta: browser.remoteMeta ?? null
	};
}

function statusOf(uid: string): string {
	const process = Process.from(uid);
	if (process) {
		return process.status;
	}
	// 渲染进程重载会清空 processes 表，但对应的浏览器子进程仍在运行。
	// 这种情况必须如实报 orphaned，不能谎报 closed——否则调用方会以为可以重新启动，
	// 而实际上 Chromium 的 profile 锁会让新实例起不来。
	return orphanedUids.has(uid) ? 'orphaned' : 'closed';
}

/** 收集浏览器：指定 parentUid 时只取其直接子级，否则遍历整棵树 */
function collectBrowsers(parentUid?: string): Browser[] {
	if (parentUid) {
		const folder = Folder.from(parentUid) as Folder | undefined;
		if (!folder) {
			throw apiError('PARENT_NOT_FOUND', `文件夹不存在: ${parentUid}`);
		}
		return Object.values(folder.children).filter((child) => child.type === 'browser') as Browser[];
	}
	return root().findAll((entity) => entity.type === 'browser') as Browser[];
}

function findBrowserByClientToken(clientToken: string): Browser | undefined {
	return collectBrowsers().find((browser) => browser.remoteMeta?.clientToken === clientToken);
}

type AutomationConfigValue = string | number | boolean | Array<string | number | boolean> | null;

interface CreatePayload {
	name?: string;
	parentUid?: string;
	clientToken?: string;
	notes?: string;
	tags?: Array<{ name: string; color: string }>;
	automationScripts?: Array<{ name: string; configs?: Record<string, AutomationConfigValue> }>;
}

/**
 * 校验并组装自动化程序配置。
 *
 * 调用方只提供「键 → 值」，这里与脚本 manifest 合并补齐 label/type/options 等
 * 展示元数据——那些本来就是脚本自己声明的，让调用方重复提供既啰嗦又容易写错。
 * 同时也拦下 manifest 里不存在的键，避免无效配置一路透传到子进程才炸。
 */
async function buildAutomationScripts(
	input: CreatePayload['automationScripts']
): Promise<RawAutomationScript[] | undefined> {
	if (!input || input.length === 0) {
		return undefined;
	}
	const available: RawAutomationScript[] = (await remote.methods.call('getRawScripts')) ?? [];
	const byName = new Map(available.map((script) => [script.name, script]));

	return input.map((item) => {
		const manifest = byName.get(item.name);
		if (!manifest) {
			throw apiError('UNKNOWN_AUTOMATION_SCRIPT', `未知的自动化程序: ${item.name}`);
		}

		// 以 manifest 声明的配置为基底，拿到 label / type / options 等元数据
		const configs: Record<string, any> = {};
		const declared = (manifest.configs ?? {}) as Record<string, any>;
		for (const [key, config] of Object.entries(declared)) {
			configs[key] = JSON.parse(JSON.stringify(config));
		}

		for (const [key, value] of Object.entries(item.configs ?? {})) {
			if (!configs[key]) {
				throw apiError(
					'INVALID_ARGUMENT',
					`自动化程序「${item.name}」没有配置项 "${key}"，可选: ${
						Object.keys(configs)
							.filter((k) => !configs[k]?.hide)
							.join(', ') || '(无)'
					}`
				);
			}
			configs[key].value = value;
		}

		return { name: item.name, configs } as RawAutomationScript;
	});
}

async function handleCreate(payload: CreatePayload) {
	const existing = payload.clientToken ? findBrowserByClientToken(payload.clientToken) : undefined;
	if (existing) {
		// 幂等命中：同一个 clientToken 重复创建只返回既有实例，
		// 这样调用方在超时后重试不会累积出无法删除的垃圾浏览器
		return { created: false, browser: serializeBrowser(existing) };
	}

	if (!store.render.setting.launchOptions.executablePath) {
		throw apiError('EXECUTABLE_PATH_NOT_SET', '浏览器路径未配置，无法创建浏览器');
	}

	let parentUid = payload.parentUid;
	if (parentUid === 'root') {
		parentUid = root().uid;
	}
	if (parentUid) {
		const folder = Folder.from(parentUid) as Folder | undefined;
		if (!folder) {
			throw apiError('PARENT_NOT_FOUND', `父文件夹不存在: ${parentUid}`);
		}
	}

	const automationScripts = await buildAutomationScripts(payload.automationScripts);

	const browser = newBrowser({
		name: payload.name,
		parentUid,
		notes: payload.notes,
		tags: payload.tags,
		automationScripts,
		// silent 会跳过 resetSearch、错误弹窗，并让实体不进入重命名态
		silent: true,
		remoteMeta: {
			clientToken: payload.clientToken,
			source: 'remote',
			createdAt: Date.now()
		}
	});

	if (!browser) {
		// 走到这里说明父文件夹解析失败等意外情况（可执行路径已在前面挡过）
		throw apiError('INTERNAL', '创建浏览器失败');
	}

	// 立即落盘：否则要等 App.vue 里 100ms 防抖的 watch 才写入，
	// 调用方拿到 201 时数据其实还在内存里
	await persistBrowserTree();

	return { created: true, browser: serializeBrowser(browser) };
}

async function handleList(payload: { parentUid?: string; clientToken?: string; running?: boolean }) {
	let list = collectBrowsers(payload.parentUid).map(serializeBrowser);
	if (payload.clientToken) {
		list = list.filter((item) => item.remoteMeta?.clientToken === payload.clientToken);
	}
	if (payload.running !== undefined) {
		list = list.filter((item) => (item.status === 'launched') === payload.running);
	}
	return { browsers: list, total: list.length };
}

async function handleGet(payload: { uid: string }) {
	const browser = Browser.from(payload.uid);
	return browser ? serializeBrowser(browser) : null;
}

async function handleLaunch(payload: { taskId?: string; uid: string }) {
	const browser = Browser.from(payload.uid);
	if (!browser) {
		throw apiError('BROWSER_NOT_FOUND', `浏览器不存在: ${payload.uid}`);
	}
	if (!store.render.setting.launchOptions.executablePath) {
		throw apiError('EXECUTABLE_PATH_NOT_SET', '浏览器路径未配置，请在软件设置中修改');
	}

	reportProgress(payload.taskId, 'precheck', '正在检查浏览器路径与用户脚本');
	await browser.launch();

	// 不能用 launch() 的返回值判成功：undefined 只代表「exit 事件之前先收到了 launched」，
	// 之后立刻崩溃也会返回 undefined。进程的实时状态才是权威判据。
	const process = Process.from(payload.uid);
	if (!process || process.status !== 'launched') {
		throw apiError('LAUNCH_FAILED', '浏览器未能进入运行状态，请查看软件内的错误提示');
	}

	reportProgress(payload.taskId, 'launched', '浏览器已启动');
	return { uid: payload.uid, status: 'launched' };
}

async function handleClose(payload: { taskId?: string; uid: string }) {
	const browser = Browser.from(payload.uid);
	if (!browser) {
		throw apiError('BROWSER_NOT_FOUND', `浏览器不存在: ${payload.uid}`);
	}
	if (!Process.from(payload.uid)) {
		throw apiError('NOT_RUNNING', `浏览器 ${payload.uid} 当前未在运行`);
	}

	reportProgress(payload.taskId, 'closing', '正在关闭浏览器');
	await browser.close();
	reportProgress(payload.taskId, 'closed', '浏览器已关闭');
	return { uid: payload.uid, status: 'closed' };
}

/** 子进程截图/查询页面的超时。截图本身很快，慢的通常是页面正在导航 */
const WORKER_OP_TIMEOUT = 15 * 1000;

/**
 * 调用子进程（ScriptWorker）并等待它通过事件回传结果。
 *
 * 父子进程之间的 IPC 是**单向**的：父进程的 shell.send 没有回执，
 * 只能"先挂监听再发指令"。这是项目里既有的范式（dashboard 里的 webrtc-page-loaded 就是这么写的）。
 *
 * requestId 用来在并发请求间区分回执归属——不带它的话，两个同时进行的截图请求
 * 会各自拿到对方的画面（A 请求先发出，B 请求后发出，B 的结果先回来时 A 会误收）。
 */
function invokeWorker<T>(
	process: Process,
	method: 'screenshotPage' | 'listPages',
	resultEvent: 'screenshot-result' | 'pages-result',
	payload: Record<string, unknown>,
	timeoutMs: number
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		// 不需要密码学强度，只要在同一会话内不撞即可
		const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		let settled = false;

		const cleanup = () => {
			clearTimeout(timer);
			process.removeListener(resultEvent, onResult);
		};

		const onResult = (result: { requestId?: string; data?: unknown; error?: { code?: string; message?: string } }) => {
			// 不是本次请求的回执（并发的另一个请求发来的），忽略
			if (!result || result.requestId !== requestId) {
				return;
			}
			settled = true;
			cleanup();
			if (result.error) {
				reject(apiError(result.error.code || 'WORKER_ERROR', result.error.message || '子进程执行失败'));
			} else {
				resolve(result.data as T);
			}
		};

		const timer = setTimeout(() => {
			if (settled) return;
			cleanup();
			reject(apiError('WORKER_TIMEOUT', '子进程响应超时，浏览器可能正在忙或已被关闭'));
		}, timeoutMs);

		process.on(resultEvent, onResult);
		// worker 的签名是 <W extends keyof ScriptWorker>，方法名在这里是动态的，放宽一下类型
		(process.worker as ((event: string, ...args: any[]) => void) | undefined)?.(method, { requestId, ...payload });
	});
}

async function handleScreenshot(payload: {
	uid: string;
	pageUrl?: string;
	format?: 'png' | 'jpeg';
	quality?: number;
	fullPage?: boolean;
}) {
	const process = Process.from(payload.uid);
	if (!process) {
		throw apiError('NOT_RUNNING', `浏览器 ${payload.uid} 当前未在运行，无法截图`);
	}
	return invokeWorker(
		process,
		'screenshotPage',
		'screenshot-result',
		{
			pageUrl: payload.pageUrl,
			format: payload.format,
			quality: payload.quality,
			fullPage: payload.fullPage
		},
		WORKER_OP_TIMEOUT
	);
}

async function handlePages(payload: { uid: string }) {
	const process = Process.from(payload.uid);
	if (!process) {
		throw apiError('NOT_RUNNING', `浏览器 ${payload.uid} 当前未在运行`);
	}
	return invokeWorker(process, 'listPages', 'pages-result', {}, WORKER_OP_TIMEOUT);
}

const handlers: Record<string, (payload: any) => Promise<unknown>> = {
	'browser.list': handleList,
	'browser.get': handleGet,
	'browser.create': handleCreate,
	'browser.launch': handleLaunch,
	'browser.close': handleClose,
	'browser.screenshot': handleScreenshot,
	'browser.pages': handlePages
};

async function dispatch(method: string, payload: unknown): Promise<unknown> {
	const handler = handlers[method];
	if (!handler) {
		throw apiError('INTERNAL', `未知的渲染侧方法: ${method}`);
	}
	return handler(payload ?? {});
}

/**
 * 上报当前运行中的浏览器及其状态。
 *
 * 主进程据此做两件事：持久化运行清单（供渲染进程重载后对账出孤儿），
 * 以及对比状态快照、只对真正变化的 uid 广播 SSE 事件。
 */
async function syncRunningState() {
	try {
		const snapshot = processes
			.filter((process) => process.status !== 'closed')
			.map((process) => ({ uid: process.uid, status: process.status as string }));

		/**
		 * 只有本次会话的第一次上报才算「重建视图」：此刻渲染进程的 processes 表是空的，
		 * 主进程记录里那些 uid 才意味着「失去句柄的孤儿」。
		 *
		 * 之后的常规上报里某个 uid 消失只代表它被正常关闭了——如果一并当孤儿处理，
		 * 关闭一个浏览器会让它的状态一直错误地显示成 orphaned。
		 */
		const freshSession = !reconciledThisSession;
		const result = await ipcRenderer.invoke(CH_SYNC_RUNNING, { snapshot, freshSession });
		reconciledThisSession = true;

		if (freshSession && result && Array.isArray(result.orphans)) {
			orphanedUids = new Set<string>(result.orphans);
		}
	} catch (err) {
		// 主进程尚未注册 handler（启动早期）或通道异常，下次同步会重试。
		// 这个异常不能静默吞掉：通道一旦持续失败，状态推送就完全失效，而表面看不出任何异常
		console.error('上报运行状态失败：', err);
	}
}

async function leaseLoop() {
	for (;;) {
		try {
			const request = await ipcRenderer.invoke(CH_LEASE);
			if (!request) {
				continue;
			}

			let result: unknown;
			try {
				result = { data: await dispatch(request.method, request.payload) };
			} catch (err) {
				result = { error: serializeError(err) };
			}

			await ipcRenderer.invoke(CH_COMPLETE, {
				id: request.id,
				generation: request.generation,
				result: toPlain(result)
			});
		} catch (err) {
			// lease 通道本身异常，退避后重试，避免打成忙循环
			console.error('远程 API lease 失败：', err);
			await sleep(1000);
		}
	}
}

/**
 * 启动 lease worker。在 App.vue 的 onMounted 中调用。
 * 纯浏览器环境（无 Electron）下直接跳过。
 */
export function startRemoteApiWorker(): void {
	if (inBrowser || started) {
		// started 同时也防止 Vite HMR 重复启动出一堆 lease 槽
		return;
	}
	started = true;

	// syncRunningState 与 leaseLoop 内部都自带 try/catch，
	// 这里再挂一层 catch 只是为了不让任何漏网的 rejection 变成未捕获异常
	syncRunningState().catch(console.error);
	/**
	 * 取值函数必须同时读 uid 和 status。
	 *
	 * Browser.launch() 是先 processes.push(process) 再调 process.launch()，
	 * push 那一刻 status 还是初始的 'closed'（会被快照过滤掉）。
	 * 如果这里只读 uid，后续 status 从 closed → launching → launched 的变化
	 * 就不会触发 watch，状态推送会一直是空的——而表面上什么都看不出。
	 *
	 * 拼成字符串是为了让 watch 按值比较，省掉 deep 遍历的开销。
	 */
	watch(
		() => processes.map((process) => `${process.uid}:${process.status}`).join('|'),
		() => {
			syncRunningState().catch(console.error);
		}
	);

	for (let i = 0; i < LEASE_SLOTS; i++) {
		leaseLoop().catch(console.error);
	}
}
