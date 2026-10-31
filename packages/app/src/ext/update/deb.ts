import { clipboard, dialog, shell } from 'electron';
import axios from 'axios';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { gt } from 'semver';
import type { UpdateInformationResource } from '@ocs-desktop/common';
import { Logger } from '../../logger';
import { store } from '../../store';
import { downloadFile, getCurrentWebContents, moveWindowToTop } from '../../utils';
import { getEffectiveFeedUrl } from './source';
import { displayVersion } from '../version';

const logger = Logger('updater-deb');

/** 当前 deb 下载的暂停控制器（null 表示没有进行中的下载） */
let activeDownloadControl: { paused: boolean } | null = null;

/** 暂停 deb 更新下载（正在传输的分块会先完成） */
export function pauseDebUpdateDownload(): boolean {
	if (!activeDownloadControl) return false;
	activeDownloadControl.paused = true;
	return true;
}

/** 继续 deb 更新下载 */
export function resumeDebUpdateDownload(): boolean {
	if (!activeDownloadControl) return false;
	activeDownloadControl.paused = false;
	return true;
}

/** 当前是否处于暂停状态 */
export function isDebUpdateDownloadPaused(): boolean {
	return !!activeDownloadControl?.paused;
}

/**
 * deb / 非 AppImage 的 Linux 更新。
 *
 * electron-updater 在 Linux 只支持 AppImage（没有 APPIMAGE 环境变量时直接拒绝），
 * 而服务器上用 deb 装在 /opt 的情况很常见。这里按 electron-updater 的 generic
 * 清单 latest-linux.yml 自己检查版本，再分片下载 deb 并尝试自动安装
 * （pkexec 密码框 → sudo -n → 回退手动命令），装完自动重启到新版本。
 */

/** 是否为「Linux 且不是 AppImage 运行」 */
export function isDebInstall(): boolean {
	return process.platform === 'linux' && !process.env.APPIMAGE;
}

/** 当前生效的 feed 根地址（自建镜像 / 自定义源 / app-update.yml 统一解析） */
function getFeedBase(): string {
	return getEffectiveFeedUrl().replace(/\/+$/, '');
}

/** deb 架构后缀（electron-builder 的命名：amd64 / arm64） */
function debArch(): string {
	return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

interface LinuxFeed {
	version: string;
	/** 清单位于哪个 feed 根目录 */
	base: string;
}

/** 读取 latest-linux.yml（清单很小，正则取 version 即可） */
async function fetchLinuxFeed(): Promise<LinuxFeed | null> {
	const base = getFeedBase();
	try {
		const { data } = await axios.get(`${base}/latest-linux.yml`, {
			timeout: 15000,
			responseType: 'text',
			// GitHub releases/latest/download 会 302 到对象存储，axios 默认跟随
			maxRedirects: 5
		});
		const version = /^version:\s*(\S+)/m.exec(String(data || ''))?.[1];
		if (!version) {
			logger.warn('latest-linux.yml 缺少 version 字段', { base });
			return null;
		}
		return { version, base };
	} catch (err) {
		logger.warn('读取更新清单失败', { base, error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

/** deb 安装包地址：清单只列 AppImage，deb 按 electron-builder 命名规则推导 */
function debUrl(base: string, version: string): string {
	return `${base}/ocs-${version}-setup-linux-${debArch()}.deb`;
}

function versionText(version: string): string {
	return displayVersion(version);
}

/**
 * 检查更新（deb）。发现新版本时通过 `detect-new-app-version` 通知渲染层弹窗。
 * 返回结构与 electron-updater 分支保持一致，供设置页「检查更新」使用。
 */
export async function checkDebUpdate(currentVersion: string): Promise<{
	current: string;
	latest: string;
	hasUpdate: boolean;
	message?: string;
}> {
	const feed = await fetchLinuxFeed();
	if (!feed) {
		return {
			current: versionText(currentVersion),
			latest: versionText(currentVersion),
			hasUpdate: false,
			message: '读取更新清单失败，请检查网络或更新源设置'
		};
	}
	const latest = feed.version;
	const hasUpdate = gt(latest, currentVersion);
	if (!hasUpdate) {
		return { current: versionText(currentVersion), latest: versionText(latest), hasUpdate: false };
	}

	const info = {
		tag: versionText(latest),
		markdown: `新版本 **${versionText(latest)}**\n\n当前为 deb 安装，更新会下载安装包并给出安装命令。`,
		description: { feat: [], fix: [], other: [] },
		url: debUrl(feed.base, latest)
	} as UpdateInformationResource;

	moveWindowToTop();
	getCurrentWebContents().send('detect-new-app-version', info);
	return { current: versionText(currentVersion), latest: versionText(latest), hasUpdate: true };
}

/** apt-get 的绝对路径（pkexec/sudo 下 PATH 可能不完整） */
const APT_GET = '/usr/bin/apt-get';

interface InstallAttempt {
	ok: boolean;
	code: number | null;
	output: string;
}

/** 运行一条安装命令，收集输出用于判断失败原因 */
function runInstallCommand(command: string, args: string[]): Promise<InstallAttempt> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-8000);
		};
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);
		child.once('error', (e) => resolve({ ok: false, code: null, output: String(e) }));
		child.once('close', (code) => resolve({ ok: code === 0, code, output }));
	});
}

/**
 * 自动安装候选命令，按优先级：
 *   1. pkexec + apt-get：桌面会话弹系统密码框（polkit 授权）；
 *   2. sudo -n + apt-get：服务器配置了 NOPASSWD 时无需交互即可安装。
 * 都不行则由调用方回退到「复制手动命令」。
 */
function installCandidates(debPath: string): Array<{ label: string; command: string; args: string[] }> {
	const list: Array<{ label: string; command: string; args: string[] }> = [];
	if (fs.existsSync('/usr/bin/pkexec')) {
		list.push({
			label: 'pkexec',
			command: '/usr/bin/pkexec',
			args: ['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', APT_GET, 'install', '-y', debPath]
		});
	}
	if (fs.existsSync('/usr/bin/sudo')) {
		list.push({ label: 'sudo -n', command: '/usr/bin/sudo', args: ['-n', APT_GET, 'install', '-y', debPath] });
	}
	return list;
}

/**
 * 给渲染层发一个更新阶段事件（update-installing / update-installed / update-install-failed）。
 * 渲染层意外不可用时不抛错，只记日志：更新流程本身不能被界面拖垮。
 */
function sendUpdatePhase(channel: string): boolean {
	try {
		getCurrentWebContents().send(channel);
		return true;
	} catch (err) {
		logger.warn(`通知渲染层 ${channel} 失败`, { error: err instanceof Error ? err.message : String(err) });
		return false;
	}
}

/** 自动安装 deb；成功时交给渲染层自动重启并返回 true，表示已处理完毕 */
async function autoInstallDeb(debPath: string): Promise<boolean> {
	if (!fs.existsSync(APT_GET)) {
		logger.info('缺少 apt-get，跳过自动安装');
		sendUpdatePhase('update-install-failed');
		return false;
	}
	// 下载完成、进入安装阶段：进度条换成「正在安装」，暂停按钮不再有意义
	sendUpdatePhase('update-installing');
	for (const candidate of installCandidates(debPath)) {
		logger.info(`尝试 ${candidate.label} 自动安装 deb`, { debPath });
		const result = await runInstallCommand(candidate.command, candidate.args);
		if (result.ok) {
			// 安装成功即自动重启：不再弹「立即重启 / 稍后」让用户再点一次。
			// 交给渲染层走完整退出流程（关闭所有浏览器 → 同步保存数据 → destroyTray），
			// 最后由主进程 app.relaunch() + quitApp(0) 拉起新版本。
			logger.info('deb 安装完成，通知渲染层自动重启', { label: candidate.label });
			if (!sendUpdatePhase('update-installed')) {
				// 渲染进程意外不可用（窗口已销毁等）：退化成提示用户手动重启，
				// 不能在这里直接 app.exit —— 浏览器还没关、数据也还没落盘
				await dialog.showMessageBox({
					title: 'OCS更新程序',
					message: '更新已安装完成，请手动重新打开软件以使用新版本。',
					type: 'info',
					noLink: true
				});
			}
			return true;
		}
		logger.warn(`${candidate.label} 安装未完成`, { code: result.code, output: result.output.slice(-300) });
	}
	// 自动安装全部失败：收起「正在安装」通知，下面回退到手动命令弹窗
	sendUpdatePhase('update-install-failed');
	return false;
}

/**
 * 下载 deb 后优先自动安装（pkexec 密码框 / 已配置的 sudo NOPASSWD），否则回退为手动命令。
 */
export async function updateDebPackage(info?: UpdateInformationResource): Promise<void> {
	let url = info?.url;
	if (!url) {
		const feed = await fetchLinuxFeed();
		if (!feed) {
			await dialog.showMessageBox({
				title: 'OCS更新程序',
				message: '读取更新清单失败，请检查网络或更新源设置。',
				type: 'error',
				noLink: true
			});
			return;
		}
		url = debUrl(feed.base, feed.version);
	}

	const fileName = path.basename(url.split('?')[0]) || 'ocs-update.deb';
	const dest = path.join(store.store.paths.downloadFolder, fileName);

	const control = { paused: false };
	activeDownloadControl = control;
	try {
		logger.info('开始下载 deb', { url, dest });
		// deb 包较大（270MB+），用 8 路分片并发；跨境链路上比单流稳定得多
		await downloadFile(
			url,
			dest,
			(rate: number, totalLength: number, chunkLength: number) => {
				getCurrentWebContents().send('update-download', rate, totalLength, chunkLength);
			},
			{ concurrency: 8, control }
		);
	} catch (err) {
		logger.error('deb 下载失败', err);
		await dialog
			.showMessageBox({
				title: 'OCS更新程序',
				message: '更新包下载失败：\n' + (err instanceof Error ? err.message : String(err)),
				type: 'error',
				noLink: true,
				buttons: ['复制下载地址', '知道了'],
				defaultId: 1,
				cancelId: 1
			})
			.then(({ response }) => {
				if (response === 0) clipboard.writeText(url as string);
			});
		return;
	} finally {
		activeDownloadControl = null;
	}

	if (await autoInstallDeb(dest)) {
		return;
	}

	const cmd = `sudo apt install -y "${dest}"`;
	const { response } = await dialog.showMessageBox({
		title: 'OCS更新程序',
		message:
			`安装包已下载到：\n${dest}\n\n` +
			`自动安装未完成（可能没有可用的系统授权弹窗），请在终端执行下面的命令完成安装：\n\n${cmd}\n\n` +
			'安装完成后重新启动软件即可。',
		type: 'info',
		noLink: true,
		buttons: ['复制命令', '打开所在文件夹', '知道了'],
		defaultId: 0,
		cancelId: 2
	});
	if (response === 0) {
		clipboard.writeText(cmd);
	} else if (response === 1) {
		shell.showItemInFolder(dest);
	}
}
