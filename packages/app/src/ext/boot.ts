import { Logger } from '../logger';
import { task } from '../utils';
import { startRemoteApi } from './remote-api';
import { startTunnel, stopTunnel } from './ssh/tunnel';

/**
 * 扩展服务的启动 / 关闭。
 *
 * 由 `packages/app/index.ts` 的两个钩子调用：
 *   - 启动：initStore() 之后、窗口创建之前；
 *   - 退出：`before-quit` 与 `process.on('exit')` 双保险。
 *
 * 每个服务都是**可选能力**：端口被占用、配置不全、指纹未确认等都只记录日志，
 * 绝不能把整个 bootstrap 拖垮（task 会把异常一路抛到 Promise.all）。
 */
export async function startExtServices(): Promise<void> {
	try {
		await task('启动远程 API', () => startRemoteApi());
	} catch (err) {
		Logger('bootstrap').error('远程 API 启动失败：', String(err));
	}
	try {
		await task('启动 SSH 隧道', () => startTunnel());
	} catch (err) {
		Logger('bootstrap').error('SSH 隧道启动失败：', String(err));
	}
}

/**
 * 退出时清理 SSH 隧道进程。
 *
 * 必须挂两个钩子，缺一不可：
 * - `before-quit` 覆盖正常的退出路径；
 * - `process.on('exit')` 是兜底。因为应用拦截退出后，渲染层最终调用的是
 *   `remote.app.call('exit', 0)`，而 **`app.exit()` 明确不会触发
 *   `before-quit` / `will-quit`** —— 只挂前者等于清理不执行，隧道会留在系统里，
 *   表现为「软件关了但端口还在转发」。
 *
 * `process.on('exit')` 里不允许异步操作，`stopTunnel()` 正是同步实现（只做 child.kill）。
 * 两个钩子都调用同一个函数，重复调用是安全的。
 */
export function shutdownExt(): void {
	stopTunnel();
}
