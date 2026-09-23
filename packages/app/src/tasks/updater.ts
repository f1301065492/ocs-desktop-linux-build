import { app, dialog, clipboard, shell } from 'electron';
import { Logger } from '../logger';
import { join } from 'path';
import fs from 'fs';
import { downloadFile, getCurrentWebContents, moveWindowToTop } from '../utils';
import { UpdateInformationResource } from '@ocs-desktop/common';
import { checkForUpdate, strategyForUrl, UpdateStrategy } from './update.source';
import { store } from '../store';

const logger = Logger('updater');

/** 检查更新。发现新版本时把信息交给渲染层弹窗 */
export async function updater() {
	const result = await checkForUpdate();
	if (!result) {
		return;
	}
	moveWindowToTop();
	getCurrentWebContents().send('detect-new-app-version', result.info);
}

/**
 * 执行更新。
 *
 * 按平台分流——**原来的实现是「下载 zip → 删掉整个 app 目录 → 解压覆盖」，
 * 那个做法只在 Windows 上成立**：
 * - AppImage 的 app.getAppPath() 在只读的 squashfs 挂载里，删不掉
 * - deb 装到 /opt（root 所有），普通用户写不了
 *
 * 现在各平台走各自可行的路径，见下面几个分支。
 */
export async function updateApp(newVersion: UpdateInformationResource) {
	const { tag, url } = newVersion;
	const strategy = strategyForUrl(url);
	logger.info(`开始更新 => tag=${tag} strategy=${strategy} url=${url}`);

	const handler = UPDATE_HANDLERS[strategy] ?? updateUnsupported;
	try {
		await handler(tag, url);
	} catch (e) {
		logger.error('更新失败', e);
		const { response } = await dialog.showMessageBox({
			title: 'OCS更新程序',
			message: 'OCS更新失败:\n' + e,
			type: 'error',
			noLink: true,
			defaultId: 1,
			buttons: ['继续使用', '复制错误日志']
		});
		if (response === 1) {
			clipboard.writeText(String(e));
		}
	}
}

/** 下载进度转发给渲染层，界面上的进度通知已经在监听这个事件 */
function progressReporter() {
	return (rate: any, totalLength: any, chunkLength: any) => {
		getCurrentWebContents().send('update-download', rate, totalLength, chunkLength);
	};
}

/** 从下载地址推出文件名，拿不到就用 tag 兜底 */
function fileNameFrom(url: string, fallback: string): string {
	const name = url.split('/').pop();
	return name && name.includes('.') ? name : fallback;
}

/**
 * AppImage 自更新。
 *
 * 关键点：**替换的是 AppImage 文件本身，而不是 app.getAppPath() 里被挂载出来的内容**。
 * AppImage 运行时会把自身挂载到一个只读的临时目录，那份是动不了的；
 * 但 AppImage 文件本身只是个普通文件，可以替换。
 *
 * `rename()` 覆盖一个正在运行的二进制在 Linux 上是允许的——旧的 inode 会保留到
 * 进程结束，所以不需要先退出。
 */
async function updateAppImage(tag: string, url: string) {
	const current = process.env.APPIMAGE;
	if (!current) {
		throw new Error('未检测到 APPIMAGE 环境变量，无法自更新。请手动下载安装包。');
	}

	// 先下到同名临时文件再改名，避免下载中途失败把现有程序弄坏
	const staging = `${current}.new-${tag}`;
	logger.info(`下载新版本到 ${staging}`);

	try {
		await downloadFile(url, staging, progressReporter());
		fs.chmodSync(staging, 0o755);
		fs.renameSync(staging, current);
	} catch (err) {
		// 失败时清理临时文件，别在用户目录里留垃圾
		fs.rmSync(staging, { force: true });
		throw err;
	}

	logger.info('AppImage 已替换，准备重启');
	await dialog.showMessageBox({
		title: 'OCS更新程序',
		message: '更新完毕，即将重启软件...',
		type: 'warning',
		noLink: true
	});

	// 必须用 AppImage 文件本身重启：进程内的 execPath 指向被挂载的临时路径，
	// 那个路径在退出后就没了
	app.relaunch({ execPath: current, args: process.argv.slice(1) });
	app.exit(0);
}

/**
 * 系统包（deb 等）：下载后交给用户用包管理器安装。
 *
 * deb 装在 /opt 需要 root，软件内提权要么存 sudo 密码、要么弹 polkit 授权，
 * 两者都不合适。下载 + 给出命令是不拿 root 能做到的极限。
 */
async function downloadPackage(tag: string, url: string) {
	const fileName = fileNameFrom(url, `ocs-${tag}.deb`);
	const dest = join(store.store.paths.downloadFolder, fileName);

	logger.info(`下载安装包到 ${dest}`);
	await downloadFile(url, dest, progressReporter());

	const cmd = `sudo apt install -y "${dest}"`;
	const { response } = await dialog.showMessageBox({
		title: 'OCS更新程序',
		message:
			`安装包已下载到：\n${dest}\n\n` +
			`请在终端执行下面的命令完成安装（需要管理员权限，软件无法代替你执行）：\n\n${cmd}\n\n` +
			`安装完成后重新启动软件即可。`,
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

/** Windows 安装程序 / macOS 磁盘映像：下载后打开，交给系统向导 */
async function downloadAndOpen(tag: string, url: string) {
	const fileName = fileNameFrom(url, `ocs-${tag}`);
	const dest = join(store.store.paths.downloadFolder, fileName);

	logger.info(`下载安装包到 ${dest}`);
	await downloadFile(url, dest, progressReporter());

	const isDiskImage = url.endsWith('.dmg');
	await dialog.showMessageBox({
		title: 'OCS更新程序',
		message: isDiskImage
			? `安装包已下载到：\n${dest}\n\n即将打开，请把应用拖入「应用程序」完成更新。`
			: `安装包已下载到：\n${dest}\n\n即将启动安装向导，按提示完成安装后请重新启动软件。`,
		type: 'info',
		noLink: true
	});

	await shell.openPath(dest);
}

/** 没有适配当前平台的产物时，只给出下载地址 */
async function updateUnsupported(tag: string, url: string) {
	const { response } = await dialog.showMessageBox({
		title: 'OCS更新程序',
		message: `发现新版本 ${tag}，但没有适配当前系统（${process.platform}）的自动更新方式。\n\n可在浏览器中打开下载页面手动下载。`,
		type: 'info',
		noLink: true,
		buttons: ['复制下载地址', '知道了'],
		defaultId: 0,
		cancelId: 1
	});
	if (response === 0) {
		clipboard.writeText(url);
	}
}

const UPDATE_HANDLERS: Partial<Record<UpdateStrategy, (tag: string, url: string) => Promise<void>>> = {
	appimage: updateAppImage,
	package: downloadPackage,
	installer: downloadAndOpen,
	'disk-image': downloadAndOpen
};
