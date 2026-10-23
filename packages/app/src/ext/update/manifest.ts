/**
 * 自建更新镜像的清单（`<mirrorBase>/latest.json`）解析。
 *
 * 客户端只认这一种结构，避免把 GitHub 的 API 形状硬塞给镜像：
 *
 * ```json
 * {
 *   "tag": "v2.13.18",
 *   "body": "可选的更新说明",
 *   "assets": {
 *     "linux": { "deb": "v2.13.18/ocs-....deb", "appimage": "v2.13.18/ocs-....AppImage" },
 *     "win32": { "exe": "v2.13.18/ocs-....exe" },
 *     "darwin": { "dmg": "v2.13.18/ocs-....dmg" }
 *   }
 * }
 * ```
 *
 * 资源地址可以是相对路径，按镜像根地址解析。
 */

export interface MirrorAssetManifest {
	tag?: string;
	body?: string;
	assets?: {
		linux?: Record<string, string | undefined>;
		win32?: Record<string, string | undefined>;
		darwin?: Record<string, string | undefined>;
	};
}

export interface ReleaseAsset {
	name: string;
	browser_download_url: string;
	size: number;
}

export interface NormalizedRelease {
	tag_name: string;
	body: string;
	html_url: string;
	assets: ReleaseAsset[];
	draft: boolean;
	prerelease: boolean;
}

function toAsset(value: unknown, base: string): ReleaseAsset | null {
	if (typeof value !== 'string' || !value.trim()) {
		return null;
	}
	let url: string;
	try {
		url = new URL(value.trim(), base).toString();
	} catch {
		return null;
	}
	const name = decodeURIComponent(url.split('/').pop() || '');
	if (!name) {
		return null;
	}
	return { name, browser_download_url: url, size: 0 };
}

/** 把镜像清单归一化成发布接口的形状；缺 tag 或没有可用资源时返回 null */
export function releaseFromManifest(
	manifest: MirrorAssetManifest | null | undefined,
	mirrorBase: string
): NormalizedRelease | null {
	if (!manifest || typeof manifest !== 'object') {
		return null;
	}
	const tag = String(manifest.tag || '').trim();
	if (!tag) {
		return null;
	}
	const base = mirrorBase.replace(/\/+$/, '') + '/';
	const assets: ReleaseAsset[] = [];
	const groups = manifest.assets || {};
	for (const platform of ['linux', 'win32', 'darwin'] as const) {
		const group = groups[platform];
		if (!group) {
			continue;
		}
		for (const value of Object.values(group)) {
			const asset = toAsset(value, base);
			if (asset) {
				assets.push(asset);
			}
		}
	}
	if (!assets.length) {
		return null;
	}
	return {
		tag_name: tag,
		body: String(manifest.body || ''),
		html_url: mirrorBase,
		assets,
		draft: false,
		prerelease: false
	};
}
