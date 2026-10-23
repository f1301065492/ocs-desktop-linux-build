import fs from 'fs';
import path from 'path';

/**
 * 浏览器档案里与「登录状态」有关的路径。
 *
 * 各站点把登录态存在 cookie 与站点本地存储里，而 Chrome 的落盘位置随版本变过，新旧两处都列上
 * （不存在时 rmSync 是空操作）：
 * - cookie：`Default/Network/Cookies`（较新版）与 `Default/Cookies`（较老版）
 * - 站点存储：`Local Storage` / `Session Storage` / `IndexedDB` / `Service Worker`
 */
const LOGIN_STATE_PATHS = [
	'Default/Cookies',
	'Default/Cookies-journal',
	'Default/Network/Cookies',
	'Default/Network/Cookies-journal',
	'Default/Local Storage',
	'Default/Session Storage',
	'Default/IndexedDB',
	'Default/Service Worker'
];

/**
 * 清除该浏览器档案里的登录状态（设置里打开「每次启动前清除登录状态」时调用）。
 *
 * 刻意**不删整个 userDataDir**：油猴脚本（ScriptCat / Tampermonkey）和它们的配置都存在档案里，
 * 整个删掉等于每次启动都要重装一遍用户脚本——那是另一条链路的事，不该被这个开关带上。
 *
 * 放在**启动前**而不是关闭时清理：浏览器异常退出、进程被杀、机器断电时关闭流程根本不会执行，
 * 而启动前清理每次必定跑到。
 */
export function clearLoginState(userDataDir: string): void {
	let removed = 0;
	for (const relative of LOGIN_STATE_PATHS) {
		try {
			const target = path.join(userDataDir, relative);
			if (fs.existsSync(target)) {
				fs.rmSync(target, { recursive: true, force: true });
				removed++;
			}
		} catch (err) {
			// 删不掉不该挡住启动：最坏情况是这次仍旧带着旧登录态，登录脚本还有机会自己识别出来
			console.error(`清除登录状态失败（${relative}）：`, err instanceof Error ? err.message : String(err));
		}
	}
	console.log(`已清除该浏览器的登录状态（cookie / 站点本地存储，清理了 ${removed} 处），本次将重新登录`);
}
