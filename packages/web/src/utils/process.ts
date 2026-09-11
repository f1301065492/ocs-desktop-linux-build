import { ChildProcess } from 'child_process';
import { remote } from './remote';
import { lang, store } from '../store';
import { LaunchOptions } from 'playwright-core';
import { reactive } from 'vue';
import type { ScriptWorker } from '@ocs-desktop/app';
import { Browser } from '../fs/browser';
import { Message } from '@arco-design/web-vue';
import EventEmitter from 'events';
import { child_process } from './node';
import { notify } from './notify';
import { Status } from './statusBar';
import { filterScriptsNeedingInstall } from './script-version';

export type RemoteScriptWorker = <W extends keyof ScriptWorker = keyof ScriptWorker>(
	event: W,
	...args: ScriptWorker[W] extends { (...args: any[]): any } ? Parameters<ScriptWorker[W]> : any[]
) => void;

/** 关闭进程的超时时间，超过则认为子进程已失联，主动放弃等待 */
export const CLOSE_TIMEOUT = 30 * 1000;

/**
 * 带错误码的进程错误。
 * 错误码用于跨 IPC 传递后让调用方（尤其是远程 API）能区分失败原因，
 * 而不是只能拿到一句中文提示。
 */
export class ProcessError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'ProcessError';
		this.code = code;
	}
}

/**
 * 运行进程
 */
export class Process extends EventEmitter {
	uid: string;
	shell?: ChildProcess;
	worker?: RemoteScriptWorker;
	/** 状态 */
	status: 'closed' | 'closing' | 'launching' | 'launched' = 'closed';
	/** 浏览器实体信息 */
	browser: Browser;
	/** 浏览器启动参数 */
	launchOptions: Required<LaunchOptions>;
	/** 输出 */
	logs: string[] = [];

	video: HTMLVideoElement | undefined = undefined;
	stream: MediaStream | undefined = undefined;

	static from(uid: string) {
		return processes.find((p) => p.uid === uid);
	}

	// 从进程列表中移除
	static remove(uid: string) {
		const index = processes.findIndex((p) => p.uid === uid);
		if (index !== -1) {
			processes.splice(index, 1);
		}
	}

	constructor(browser: Browser, launchOptions: LaunchOptions) {
		super();
		this.browser = browser;
		this.uid = browser.uid;
		this.launchOptions = launchOptions as any;
	}

	/**
	 * 使用 child_process 运行 ocs 命令
	 */
	async init(onConsole?: (data: any) => void) {
		this.shell = child_process.fork(
			await remote.path.call('join', await remote.app.call('getAppPath'), './script.js'),
			{
				stdio: ['ipc'],
				env: process.env
			}
		);
		this.worker = createRemoteScriptWorker(this.shell);

		this.shell.stdout?.on('data', (data: any) => {
			this.logs.push(data.toString());
			onConsole?.(data.toString());
		});
		this.shell.stderr?.on('data', (data: any) => {
			onConsole?.(data.toString());
			remote.logger.call('error', String(data));
			this.logs.push(`${this.browser.name} 错误`, data);
			notify(`${this.browser.name} 错误`, data, this.browser.uid, {
				duration: 60 * 1000,
				copy: true,
				type: 'error'
			});
		});

		/** 监听器 */
		const listeners: Record<string, (...args: any[]) => void> = {
			/** 浏览器启动 */
			launched: async () => {
				this.status = 'launched';
			},
			/**
			 * 浏览器关闭
			 * 可以由 browser.close() 关闭
			 * 或者进程主动触发
			 */
			'browser-closed': () => {
				console.log('browser-closed', this.uid);
				// 从进程列表中移除
				Process.remove(this.uid);
			}
		};

		this.shell.on('message', ({ event, args }: { event: string; args: any[] }) => {
			// 将 shell 的事件共享到当前的对象
			this.emit(event, ...args);
			if (listeners[event]) {
				listeners[event](...args);
			}
		});

		// 初始化进程数据
		this.worker('init', {
			store,
			cachePath: this.browser.cachePath,
			uid: this.uid,
			automationScripts: this.browser.automationScripts,
			browserInfo: {
				name: this.browser.name,
				notes: this.browser.notes,
				tags: this.browser.tags
			},
			config: {
				enable_dialog: store.render.setting.browser.enableDialog
			},
			langs: store.render.langs as any
		});
	}

	async launchPreCheck() {
		// 检查
		// 注意：以下失败路径必须 throw 而不是 return，
		// 否则 launch() 的 then 收到 undefined 后既不 resolve 也不 reject，调用方会永久挂起。
		if (!this.launchOptions.executablePath) {
			Message.error('浏览器路径为空，请在软件设置中修改');
			throw new ProcessError('EXECUTABLE_PATH_NOT_SET', '浏览器路径为空，请在软件设置中修改');
		}

		try {
			const exists = await remote.fs.call('existsSync', this.launchOptions.executablePath);
			if (!exists) {
				Message.error('浏览器路径不存在，请在软件设置中修改');
				throw new ProcessError('EXECUTABLE_PATH_NOT_FOUND', '浏览器路径不存在，请在软件设置中修改');
			}

			// 脚本检查
			Status.loading('正在检查本地脚本...');
			const enabledUserScripts = store.render.scripts.filter((s) => s.enable);
			for (const s of enabledUserScripts) {
				if (!s.url.startsWith('http')) {
					const res = await remote.fs.call('existsSync', s.info?.code_url || s.url);
					if (!res) {
						notify(
							'本地脚本不存在',
							lang('error_when_script_not_found', `本地脚本 ${s.info?.name}：(${s.url})\n不存在，请检查脚本路径`, {
								name: s.info?.name || '',
								url: s.url
							}),
							'process_launch_error_' + s.url,
							{
								duration: 60 * 1000,
								type: 'warning',
								copy: true
							}
						);
					}
				}
			}

			Status.loading('正在检查脚本更新...');
			const scriptsToInstall = await filterScriptsNeedingInstall(enabledUserScripts);
			if (scriptsToInstall.length > 0) {
				Status.loading(`正在启动 ${this.browser.name}（需更新/安装 ${scriptsToInstall.length} 个脚本）...`);
			} else {
				Status.loading(`正在启动 ${this.browser.name}（脚本均为最新，无需更新）...`);
			}
			this.once('launched', () => {
				// 安装成功后更新 lastInstalledVersion
				for (const item of scriptsToInstall) {
					item.script.lastInstalledVersion = item.latestVersion;
				}
				Status.clear();
			});
			this.shell?.once('exit', (code) => {
				Status.clear();
			});
			return { scriptsToInstall, enabledScriptCount: enabledUserScripts.length };
		} catch (err) {
			// 上面主动抛出的 ProcessError 原样透传，其余异常包装后抛出
			if (err instanceof ProcessError) {
				throw err;
			}
			Message.error('浏览器路径读取错误 : ' + String(err));
			throw new ProcessError('PRECHECK_FAILED', '浏览器路径读取错误 : ' + String(err));
		}
	}

	/** 启动文件 */
	launch() {
		return new Promise<void | number | null>((resolve, reject) => {
			this.status = 'launching';
			this.launchPreCheck()
				.then((result) => {
					// 兜底：launchPreCheck 的契约是「成功返回结果，失败抛异常并已被 catch 处理」。
					// 这里再挡一道，避免契约被破坏后调用方静默挂起。
					if (!result) {
						this.status = 'closed';
						reject(new ProcessError('PRECHECK_FAILED', '启动前置检查未返回结果'));
						return;
					}
					this.once('launched', () => {
						resolve();
					});
					this.shell?.once('exit', (code) => {
						resolve(code);
					});
					this.worker?.('launch', {
						userDataDir: this.browser.cachePath,
						// 这里要加密编码，防止路径中有中文等特殊字符，会无法安装脚本
						enabledScriptCount: result.enabledScriptCount,
						userscripts: result.scriptsToInstall.map((item) =>
							item.script.isLocalScript
								? `http://localhost:${store.server.port}/api/local-userscript?path=${encodeURIComponent(
										item.script.info?.code_url || item.script.url
								  )}`
								: item.script.info?.code_url || item.script.url
						),
						...this.launchOptions
					});
				})
				.catch(reject);
		});
	}

	/** 关闭进程 */
	async close() {
		// 标记为 closing ，使监控页面，以及操作栏的图标可以判断状态
		this.status = 'closing';
		return new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			/**
			 * 超时兜底：createRemoteScriptWorker 在 shell.connected 为 false 时
			 * 不会真正发出消息，此时 browser-closed 永远不会到达，close() 会永久挂起。
			 * 超时后主动把进程从表中摘除以避免僵尸条目。
			 */
			const timer = setTimeout(() => {
				Process.remove(this.uid);
				finish();
			}, CLOSE_TIMEOUT);
			this.once('browser-closed', finish);
			// 关闭进程
			this.worker?.('close');
		});
	}

	/** 显示当前的浏览器  */
	bringToFront() {
		if (this.status === 'launched' && this.launchOptions) {
			const action = `http://localhost:${store.server.port}/ocs-action_bring-to-top`;
			child_process.exec(
				`"${this.launchOptions.executablePath}" --user-data-dir="${this.browser.cachePath}" "${action}"`
			);
			this.worker?.('bringToFront');
			Message.warning('已置顶，如未生效，电脑底部任务栏闪烁的浏览器图标即为置顶浏览器。');
		} else {
			Message.warning('必须先启动文件');
		}
	}

	toString() {
		return '[Process]';
	}
}

export const processes: Process[] = reactive([]);

/**
 * 创建  ScriptWorker Shell 调用 APi
 * @param shell
 */
function createRemoteScriptWorker(shell: ChildProcess) {
	return <W extends keyof ScriptWorker, F extends ScriptWorker[W]>(
		event: W,
		...args: F extends { (...args: any[]): any } ? Parameters<F> : any[]
	) => {
		if (shell.connected) {
			shell.send({ event, args });
		}
	};
}
