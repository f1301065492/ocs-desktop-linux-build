import { clipboard, dialog, shell } from 'electron';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { gt } from 'semver';
import type { UpdateInformationResource } from '@ocs-desktop/common';
import { Logger } from '../../logger';
import { store } from '../../store';
import { downloadFile, getCurrentWebContents, moveWindowToTop } from '../../utils';
import { getUpdateSourceConfig } from './source';
import { displayVersion } from '../version';

const logger = Logger('updater-deb');

/**
 * deb / 非 AppImage 的 Linux 更新。
 *
 * electron-updater 在 Linux 只支持 AppImage（没有 APPIMAGE 环境变量时直接拒绝），
 * 而服务器上用 deb 装在 /opt 的情况很常见。这里按 electron-updater 的 generic
 * 清单 latest-linux.yml 自己检查版本，再下载对应 deb 并给出 apt 安装命令。
 */

/** 默认 feed（与 electron.builder.json 的 publish.url 保持一致） */
const DEFAULT_FEED = 'https://github.com/f1301065492/ocs-desktop-linux-build/releases/latest/download';

/** 是否为「Linux 且不是 AppImage 运行」 */
export function isDebInstall(): boolean {
	return process.platform === 'linux' && !process.env.APPIMAGE;
}

/** 读取打包时写入的 app-update.yml 里的 feed 地址，读不到则用常量 */
function getDefaultFeed(): string {
	try {
		const file = path.join(process.resourcesPath, 'app-update.yml');
		const content = fs.readFileSync(file, 'utf8');
		const match = /^url:\s*(.+)$/m.exec(content);
		if (match) {
			return match[1].trim().replace(/\/+$/, '');
		}
	} catch {
		// 开发环境或精简包没有该文件
	}
	return DEFAULT_FEED;
}

/** 当前生效的 feed 根地址（自建镜像优先） */
function getFeedBase(): string {
	const cfg = getUpdateSourceConfig();
	if (cfg.source === 'mirror' && cfg.mirrorBase) {
		return cfg.mirrorBase.replace(/\/+$/, '');
	}
	return getDefaultFeed();
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

/**
 * 下载 deb 并提示安装。deb 装在 /opt 需要 root，软件内不代执行 sudo。
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

	try {
		logger.info('开始下载 deb', { url, dest });
		await downloadFile(url, dest, (rate: number, totalLength: number, chunkLength: number) => {
			getCurrentWebContents().send('update-download', rate, totalLength, chunkLength);
		});
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
	}

	const cmd = `sudo apt install -y "${dest}"`;
	const { response } = await dialog.showMessageBox({
		title: 'OCS更新程序',
		message:
			`安装包已下载到：\n${dest}\n\n` +
			`请在终端执行下面的命令完成安装（需要管理员权限，软件无法代替你执行）：\n\n${cmd}\n\n` +
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
