import { app } from 'electron';
import axios from 'axios';
import { gt } from 'semver';
import { UpdateInformationResource } from '@ocs-desktop/common';
import { Logger } from '../logger';

const logger = Logger('updater');

/**
 * 更新源：本项目的发布仓库。
 *
 * 原先走的是 OCSApi.getInfos() → cdn.ocsjs.com，那是**上游项目**的 CDN。
 * 对这份 fork 来说，它只会提示"上游有新版本"，点了还会把软件覆盖成上游版本，
 * 所以改成直接读自己的 GitHub Releases。
 *
 * 仓库必须是公开的——客户端是匿名请求，私有仓库的 Releases API 需要 token，
 * 而把 token 打进客户端等于公开发布。
 */
const RELEASE_REPO = 'f1301065492/ocs-desktop-linux-build';
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const REQUEST_TIMEOUT = 10000;

interface GithubAsset {
	name: string;
	browser_download_url: string;
	size: number;
}

interface GithubRelease {
	tag_name: string;
	name: string;
	body: string;
	html_url: string;
	assets: GithubAsset[];
	draft: boolean;
	prerelease: boolean;
}

/** 本地该用哪种方式更新 */
export type UpdateStrategy =
	/** AppImage：下载新文件替换自身并重启，真正的一键更新 */
	| 'appimage'
	/** 系统包（deb 等）：下载后由用户用包管理器安装（需要 root） */
	| 'package'
	/** Windows 安装程序：下载后拉起安装向导 */
	| 'installer'
	/** macOS 磁盘映像：下载后打开，用户手动拖入 */
	| 'disk-image'
	/** 找不到适配当前平台的安装包 */
	| 'unsupported';

export interface UpdateCheckResult {
	/** 归一化成 OCS 既有的更新资源形状，渲染侧的弹窗因此不用改 */
	info: UpdateInformationResource;
	/** 选中的安装包 */
	asset: GithubAsset;
	strategy: UpdateStrategy;
}

/**
 * 当前是否以 AppImage 方式运行。
 *
 * 这是唯一可靠的判据：只有通过 AppImage 启动时这个变量才有值。
 * 用它区分「能自替换」和「装到 /opt 需要 root」两种情况。
 */
export function isRunningAsAppImage(): boolean {
	return Boolean(process.env.APPIMAGE);
}

/**
 * 按平台与运行方式挑选合适的安装包，并决定更新策略。
 *
 * 参数类型刻意用 string 而不是 NodeJS.Platform——项目的 eslint 配置不含 Node 全局，
 * 引用 NodeJS 命名空间会报 no-undef。
 */
function pickAsset(
	assets: GithubAsset[],
	platform: string = process.platform
): { asset: GithubAsset; strategy: UpdateStrategy } | null {
	const endsWith = (suffix: string) => assets.find((a) => a.name.endsWith(suffix));

	if (platform === 'linux') {
		if (isRunningAsAppImage()) {
			const appImage = endsWith('.AppImage');
			if (appImage) return { asset: appImage, strategy: 'appimage' };
		}
		// 非 AppImage（deb 安装等）：/opt 下需要 root，只能下载后让用户装
		const deb = endsWith('.deb');
		if (deb) return { asset: deb, strategy: 'package' };
		// 兜底：以 AppImage 方式跑的，但这次没有 AppImage 产物
		const appImage = endsWith('.AppImage');
		if (appImage) return { asset: appImage, strategy: 'appimage' };
		return null;
	}

	if (platform === 'win32') {
		const exe = endsWith('.exe');
		return exe ? { asset: exe, strategy: 'installer' } : null;
	}

	if (platform === 'darwin') {
		const dmg = endsWith('.dmg');
		return dmg ? { asset: dmg, strategy: 'disk-image' } : null;
	}

	return null;
}

/** 把 Release 正文按行塞进 OCS 既有的 description 结构，渲染侧照旧渲染 */
function toDescription(body: string): UpdateInformationResource['description'] {
	const lines = (body || '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	return { feat: [], fix: [], other: lines };
}

/**
 * 检查是否有新版本。
 *
 * 网络不通、仓库没发过 Release、找不到适配当前平台的产物——这些都返回 null，
 * 只记日志。检查更新失败不该打扰使用者，更不该让启动流程出问题。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
	let release: GithubRelease;
	try {
		const { data } = await axios.get<GithubRelease>(LATEST_RELEASE_API, {
			timeout: REQUEST_TIMEOUT,
			headers: { Accept: 'application/vnd.github+json' }
		});
		release = data;
	} catch (err) {
		logger.info(`检查更新失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}

	if (!release || release.draft || !release.tag_name) {
		return null;
	}

	// 统一按 semver 比较。tag 形如 v2.13.1，semver 能直接吃 v 前缀
	const current = app.getVersion();
	if (!gt(release.tag_name, current)) {
		logger.info(`已是最新版本 (${current})，线上为 ${release.tag_name}`);
		return null;
	}

	const picked = pickAsset(release.assets || []);
	if (!picked) {
		logger.warn(`发现新版本 ${release.tag_name}，但没有适配本平台（${process.platform}）的安装包`);
		return null;
	}

	logger.info(`发现新版本 ${release.tag_name}，策略=${picked.strategy}，包=${picked.asset.name}`);

	return {
		info: {
			tag: release.tag_name,
			description: toDescription(release.body),
			url: picked.asset.browser_download_url,
			// 保留这个字段，方便其他消费方（如 Setup 向导）拿到各平台下载地址
			app_downloads: {
				win32: release.assets.find((a) => a.name.endsWith('.exe'))?.browser_download_url,
				darwin: release.assets.find((a) => a.name.endsWith('.dmg'))?.browser_download_url,
				linux: release.assets.find((a) => a.name.endsWith('.deb'))?.browser_download_url
			}
		},
		asset: picked.asset,
		strategy: picked.strategy
	};
}

/** 判断某个下载地址对应哪种更新策略（供 updateApp 使用） */
export function strategyForUrl(url: string): UpdateStrategy {
	if (url.endsWith('.AppImage')) return 'appimage';
	if (url.endsWith('.deb')) return 'package';
	if (url.endsWith('.exe')) return 'installer';
	if (url.endsWith('.dmg')) return 'disk-image';
	return 'unsupported';
}
