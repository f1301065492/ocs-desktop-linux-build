import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';

/**
 * Linux 无图形界面时给 Playwright 准备一个 XServer。
 *
 * 背景：Playwright 启动有头 Chromium 时必须有可用的显示；服务器/容器里
 * 通常没有。这里按以下顺序处理：
 *   0. 已有可用 Wayland 会话 → 不动环境，交给 Chromium 的 --ozone-platform-hint=auto；
 *   1. 现有 DISPLAY 有效（本地 :N 且 socket 存在）→ 直接用；
 *   2. 机器上已有其他 Xvfb（/tmp/.X11-unix/X99…）→ 复用；
 *   3. 启动一个仅本 worker 使用的 Xvfb（独立 display 号）；
 *   4. 都没有（没装 xvfb）→ 退回 headless，保证浏览器至少能启动。
 */

let xvfbProcess: ChildProcess | null = null;

function socketPath(displayNumber: number): string {
	return `/tmp/.X11-unix/X${displayNumber}`;
}

function hasSocket(displayNumber: number): boolean {
	try {
		return fs.existsSync(socketPath(displayNumber));
	} catch {
		return false;
	}
}

/**
 * 切到 X11：设置 DISPLAY，并清掉可能让 Chromium 选择 Wayland 的变量。
 *
 * 服务器上常见「有 Xvfb 但也继承了 WAYLAND_DISPLAY」：Electron/Chromium 会优先走
 * Wayland，连不上合成器时 Playwright 就报 “headed browser without XServer”。
 */
function useX11(display: string): boolean {
	process.env.DISPLAY = display;
	delete process.env.WAYLAND_DISPLAY;
	delete process.env.XDG_SESSION_TYPE;
	return false;
}

/** 从 DISPLAY 解析本地 display 号；远程 display（host:0）返回 null */
function localDisplayNumber(display: string | undefined): number | null {
	if (!display) return null;
	const match = /^:(\d+)(?:\.\d+)?$/.exec(display.trim());
	return match ? Number(match[1]) : null;
}

function waitForSocket(displayNumber: number, timeoutMs: number, aborted: () => boolean): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const check = () => {
			if (hasSocket(displayNumber)) {
				resolve(true);
				return;
			}
			if (aborted() || Date.now() >= deadline) {
				resolve(false);
				return;
			}
			setTimeout(check, 100);
		};
		check();
	});
}

/**
 * 是否是可用的 Wayland 会话。
 *
 * 有 Wayland socket 时不应强行拉 Xvfb：Chromium 3.6 起带 `--ozone-platform-hint=auto`，
 * 会自动优先 Wayland，既避免额外进程，也让纯 Wayland 桌面（无 XWayland）正常有头启动。
 */
function hasWayland(): boolean {
	const name = process.env.WAYLAND_DISPLAY;
	if (!name) return false;
	try {
		if (name.startsWith('/')) {
			return fs.existsSync(name);
		}
		const runtimeDir = process.env.XDG_RUNTIME_DIR;
		return !!runtimeDir && fs.existsSync(`${runtimeDir}/${name}`);
	} catch {
		return false;
	}
}

/**
 * 确保 Linux 上有可用的 XServer。
 * @returns 实际应使用的 headless 值（没有可用 X 且无法启动 Xvfb 时为 true）
 */
export async function ensureLinuxDisplay(headless: boolean): Promise<boolean> {
	if (process.platform !== 'linux' || headless) {
		return headless;
	}

	if (hasWayland()) {
		console.log(`[显示] 检测到 Wayland 会话（WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}），交给 Chromium 自动选择`);
		return false;
	}

	const currentDisplay = process.env.DISPLAY;
	const currentNumber = localDisplayNumber(currentDisplay);
	if (currentDisplay) {
		// 远程 display 无法用本地 socket 判断，直接信任
		if (currentNumber === null || hasSocket(currentNumber)) {
			return useX11(currentDisplay);
		}
		console.warn(`[显示] DISPLAY=${currentDisplay} 的 X socket 不存在，尝试启动 Xvfb`);
	}

	// 复用已存在的本地 Xvfb（例如用户自己起的 xvfb-run）
	for (let n = 99; n <= 120; n += 1) {
		if (hasSocket(n)) {
			console.log(`[显示] 复用已有 Xvfb：DISPLAY=:${n}`);
			return useX11(`:${n}`);
		}
	}

	// 每个 worker 用独立 display，避免多个浏览器互相干扰
	const base = 120 + (process.pid % 300);
	for (let i = 0; i < 20; i += 1) {
		const n = base + i;
		if (hasSocket(n)) {
			continue;
		}
		let spawnFailed = false;
		const child = spawn('Xvfb', [`:${n}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
			stdio: 'ignore'
		});
		child.once('error', () => {
			spawnFailed = true;
		});
		const ok = await waitForSocket(n, 3000, () => spawnFailed || child.exitCode !== null);
		if (ok) {
			xvfbProcess = child;
			console.log(`[显示] 已启动 Xvfb：DISPLAY=:${n}`);
			return useX11(`:${n}`);
		}
		try {
			child.kill();
		} catch {
			// 已退出
		}
	}

	// 没装 xvfb：退回无头模式，至少能启动（扩展加载可能受限）
	console.warn('[显示] 未检测到 XServer 且 Xvfb 不可用，改用无头模式。服务器建议安装：sudo apt install -y xvfb');
	console.log('[浏览器] 未检测到图形界面且 Xvfb 不可用，已退回无头模式；建议安装 xvfb 以正常加载扩展');
	return true;
}

/** 退出时结束本 worker 启动的 Xvfb */
function stopXvfb() {
	if (xvfbProcess) {
		try {
			xvfbProcess.kill();
		} catch {
			// 已退出
		}
		xvfbProcess = null;
	}
}

process.on('exit', stopXvfb);
