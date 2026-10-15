import { remote } from './remote';
import { store, StoreUserScript } from '../store';

/**
 * 将 .user.js 链接转换为 .meta.js 链接，并移除 version 查询参数
 * 例：https://greasyfork.org/scripts/123/foo.user.js?version=2.0
 *   → https://greasyfork.org/scripts/123/foo.meta.js
 */
export function getMetaUrl(codeUrl: string): string {
	if (!codeUrl) return codeUrl;
	// 移除 ?version=xxx 查询参数，meta 只关心最新版本
	const url = new URL(codeUrl);
	url.searchParams.delete('version');
	// 替换 .user.js 为 .meta.js
	const href = url.toString();
	if (href.endsWith('.user.js')) {
		return href.replace(/\.user\.js$/, '.meta.js');
	}
	// URL 不以 .user.js 结尾，可能不支持 meta.js 约定
	return href;
}

/**
 * 从 meta.js 文本内容中解析 @version 字段
 * 复用与 user-scripts.ts 相同的正则逻辑
 */
export function parseVersionFromMeta(metaText: string): string | undefined {
	const metadata = metaText.match(/\/\/\s+==UserScript==([\s\S]+)\/\/\s+==\/UserScript==/)?.[1] || '';
	if (metadata === '') return undefined;

	const metadataList = (metadata.match(/\/\/\s+@(.+?)\s+(.*?)(?:\n|$)/g) || []).map((line) => {
		const words = line.match(/[\S]+/g) || [];
		return {
			key: (words[1] || '').replace('@', ''),
			value: words.slice(2).join(' ')
		};
	});

	const getVersion = (key: string) => {
		return metadataList.filter((l) => l.key === key).map((l) => l.value);
	};

	return getVersion('version')[0];
}

export interface FetchVersionResult {
	/** 解析到的远程版本号 */
	version: string | undefined;
	/**
	 * meta.js 是否可用
	 * - true: 正常获取到 meta.js（无论是否解析出 version）
	 * - false: meta.js 返回 404/403，说明该脚本源当前不支持 meta 约定
	 * - undefined: 网络异常等暂时性错误，下次仍需重试
	 */
	metaSupported: boolean | undefined;
}

/**
 * 获取远程脚本的最新版本号（通过 .meta.js）
 *
 * 返回结果区分三种情况：
 * - metaSupported=true + version 有值：正常拿到版本号
 * - metaSupported=false：该脚本源当前不支持 .meta.js 约定（404/403），本次降级处理
 * - metaSupported=undefined：网络异常等暂时性错误，仍可重试
 */
export async function fetchRemoteVersion(codeUrl: string): Promise<FetchVersionResult> {
	const metaUrl = getMetaUrl(codeUrl);
	console.log('脚本更新 meta-url', metaUrl);
	try {
		const res = await remote.methods.call('getWithStatus', metaUrl);
		console.log('脚本更新 res', res);
		// 区分 HTTP 状态码
		const status: number | undefined = res?.status;
		if (status === 404 || status === 403) {
			// 脚本源当前不支持 .meta.js 约定
			return { version: undefined, metaSupported: false };
		}
		if (status && (status < 200 || status >= 300)) {
			// 其他 HTTP 错误（5xx 等），视为暂时性错误
			return { version: undefined, metaSupported: undefined };
		}
		// 正常响应（2xx）
		const metaText = res?.data;
		if (typeof metaText === 'string') {
			const version = parseVersionFromMeta(metaText);
			return { version, metaSupported: true };
		}
		return { version: undefined, metaSupported: true };
	} catch (e) {
		// 网络异常，视为暂时性错误
		return { version: undefined, metaSupported: undefined };
	}
}

/**
 * 回退抓取脚本正文解析版本的结果缓存。
 *
 * 官方 OCS 网课助手（https://cdn.ocsjs.com/ocs.user.js，约 1MB）没有对应的 ocs.meta.js（404），
 * 只能拉正文解析 @version；同一会话里连续启动多个浏览器时不该每次都重新下载一份。
 * 只缓存「解析成功」的结果，失败下次仍会重试。
 */
const SCRIPT_BODY_VERSION_CACHE_TTL = 10 * 60 * 1000;
const scriptBodyVersionCache = new Map<string, { version: string; time: number }>();

/**
 * 拉取脚本正文，从 UserScript 头里解析 @version。
 *
 * 用于脚本源不支持 .meta.js 约定的场景（如官方 OCS 网课助手所在 CDN）。
 */
export async function fetchScriptVersion(codeUrl: string): Promise<string | undefined> {
	const cached = scriptBodyVersionCache.get(codeUrl);
	if (cached && Date.now() - cached.time < SCRIPT_BODY_VERSION_CACHE_TTL) {
		return cached.version;
	}

	try {
		const res = await remote.methods.call('getWithStatus', codeUrl);
		const status: number | undefined = res?.status;
		if (status && (status < 200 || status >= 300)) {
			return undefined;
		}
		const text = res?.data;
		if (typeof text !== 'string') {
			return undefined;
		}
		const version = parseVersionFromMeta(text);
		if (version) {
			scriptBodyVersionCache.set(codeUrl, { version, time: Date.now() });
		}
		return version;
	} catch (e) {
		return undefined;
	}
}

/** 远端最新版本及其来源 */
export interface RemoteVersionResult {
	/** 解析到的最新版本号，undefined 表示这次没拿到 */
	version: string | undefined;
	/** meta.js 拿到的 / 脚本正文拿到的 / 都没拿到 */
	source: 'meta' | 'script' | 'none';
}

/**
 * 解析远端脚本的最新版本号。
 *
 * 优先用 .meta.js（几十字节，最省流量）；脚本源不支持 meta 约定时回退到拉脚本正文解析。
 *
 * ⚠️ 这里必须真的去问远端，不能用 script.info.version 代替：那份缓存只在「添加脚本」时写入一次，
 * 之后再也不会刷新。官方 OCS 网课助手这类没有 meta.js 的脚本，一旦拿它当「远端最新版本」，
 * 结果就和已安装版本永远相等 —— 脚本更新后软件会一直判定「无需安装」，浏览器里停留在旧版本。
 */
export async function resolveRemoteVersion(codeUrl: string): Promise<RemoteVersionResult> {
	const meta = await fetchRemoteVersion(codeUrl);
	if (meta.version !== undefined) {
		return { version: meta.version, source: 'meta' };
	}

	// meta 拿到 404/403，或响应里没有 @version → 拉正文兜底
	const bodyVersion = await fetchScriptVersion(codeUrl);
	if (bodyVersion !== undefined) {
		return { version: bodyVersion, source: 'script' };
	}

	return { version: undefined, source: 'none' };
}

/**
 * 轻量級版本比较函数，按 "." 分割逐段比较数值
 * 返回 -1 表示 v1 < v2，0 表示相等，1 表示 v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
	const parts1 = v1.split('.').map((p) => parseInt(p, 10) || 0);
	const parts2 = v2.split('.').map((p) => parseInt(p, 10) || 0);
	const maxLen = Math.max(parts1.length, parts2.length);

	for (let i = 0; i < maxLen; i++) {
		const n1 = parts1[i] ?? 0;
		const n2 = parts2[i] ?? 0;
		if (n1 > n2) return 1;
		if (n1 < n2) return -1;
	}
	return 0;
}

/**
 * 从 code_url 中提取 ?version=xxx 参数
 * 如果存在，说明用户指定了该版本
 *
 * 版本号可能包含字母、点号、连字符、逗号等，如 1.0.0-beta、2.0a、1,0,0
 * 因此匹配到下一个 & 或字符串结尾为止，而非限定字符集
 */
export function getSpecifiedVersion(codeUrl: string): string | undefined {
	if (!codeUrl) return undefined;
	const match = codeUrl.match(/[?&]version=([^&]+)/);
	return match ? decodeURIComponent(match[1]) : undefined;
}

/** 需要安装的脚本项，携带确定的最新版本号 */
export interface ScriptToInstall {
	script: StoreUserScript;
	/** 确定的最新版本号，浏览器安装成功后记录到该浏览器的 userscriptVersions 上 */
	latestVersion: string;
}

/**
 * 过滤出需要安装/更新的脚本
 *
 * 判定逻辑：
 * 1. isLocalScript → 始终安装（本地脚本可能被修改了）
 * 2. 强制安装开关开启 → 始终安装
 * 3. 该浏览器没有这个脚本的安装记录 → 安装（含新建的浏览器）
 * 4. code_url 含 ?version=xxx（用户指定了版本）→ 比较已安装版本与指定版本，不同则安装
 * 5. 其他网络脚本 → resolveRemoteVersion 获取远程最新版本 → 与已安装版本比较
 * 6. 拿不到远程版本（网络异常等）→ 降级为安装（保守策略）
 *
 * @param scripts 已启用的用户脚本
 * @param installedVersions 该浏览器（profile）上已安装的脚本版本，key 为脚本条目的 url
 */
export async function filterScriptsNeedingInstall(
	scripts: StoreUserScript[],
	installedVersions: Record<string, string> = {}
): Promise<ScriptToInstall[]> {
	const forceUpdate = store.render.setting.browser.forceUpdateScript;
	const result: ScriptToInstall[] = [];

	for (const script of scripts) {
		const codeUrl = script.info?.code_url || script.url;
		// 已安装版本必须按浏览器取：脚本条目上的 lastInstalledVersion 是全软件共用的，
		// 新建的浏览器（全新 profile，里面根本没有脚本）会被它误判成「已装最新版」而跳过安装。
		const installedVersion = installedVersions[script.url];

		// 1. 本地脚本始终安装
		if (script.isLocalScript) {
			result.push({ script, latestVersion: script.info?.version || '' });
			continue;
		}

		// 2. 强制安装模式始终安装
		if (forceUpdate) {
			result.push({ script, latestVersion: script.info?.version || '' });
			continue;
		}

		// 3. 这个浏览器从未装过 → 首次安装
		if (!installedVersion) {
			result.push({ script, latestVersion: script.info?.version || '' });
			continue;
		}

		// 4. 用户指定了版本 → 比较已安装版本与指定版本，不同则安装
		const specifiedVersion = getSpecifiedVersion(codeUrl);
		if (specifiedVersion) {
			if (compareVersions(installedVersion, specifiedVersion) !== 0) {
				result.push({ script, latestVersion: specifiedVersion });
			}
			continue;
		}

		// 5, 6. 获取远程最新版本
		const remote = await resolveRemoteVersion(codeUrl);

		if (remote.version === undefined) {
			// 网络异常等暂时性问题 → 保守策略，仍然安装
			result.push({ script, latestVersion: script.info?.version || '' });
			continue;
		}

		// 顺手把真实的最新版本写回脚本信息：官方脚本的 info.version 只在添加脚本时写入一次，
		// 不刷新的话界面上显示的版本会一直停在添加那一刻。
		if (script.info && script.info.version !== remote.version) {
			script.info.version = remote.version;
		}

		if (compareVersions(installedVersion, remote.version) !== 0) {
			result.push({ script, latestVersion: remote.version });
		}
	}

	return result;
}
