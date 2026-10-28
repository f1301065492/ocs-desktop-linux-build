import fs from 'fs';
import path from 'path';
import { OCS_UPDATER } from '@ocs-desktop/common';
import { store } from '../../store';

/** 打包时 electron-builder 按 publish.url 写入的更新源（开发模式不存在） */
function packagedFeedUrl(): string | undefined {
	try {
		const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
		const match = /^url:\s*(.+)$/m.exec(yml);
		return match?.[1]?.replace(/^['"]|['"]$/g, '').trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * 当前实际生效的更新源目录（与 electron-updater 用的地址保持一致）。
 *
 * 上游 3.6 起更新弹窗会从更新源拉 `CHANGELOG.md`，所以这里也要按同一地址取，
 * 不能用上游默认 CDN：优先级 自建镜像 > store 自定义 feedUrl > app-update.yml > 上游默认。
 */
export function getEffectiveFeedUrl(): string {
	const cfg = getUpdateSourceConfig();
	const candidates = [
		cfg.source === 'mirror' ? cfg.mirrorBase : '',
		store.store.updater?.feedUrl,
		packagedFeedUrl(),
		OCS_UPDATER.feedUrl
	];
	const url =
		candidates.find((item): item is string => typeof item === 'string' && !!item.trim()) ?? OCS_UPDATER.feedUrl;
	return url.trim().replace(/\/?$/, '/');
}

/**
 * 更新源配置（扩展）。
 *
 * 上游 3.x 的更新由 electron-updater 负责，支持通过 `store.updater.feedUrl` 指定
 * generic 更新源；这里把设置页的「GitHub / 自建镜像」选择翻译成 feedUrl：
 * - github：清空 feedUrl，走构建时的默认源；
 * - mirror：把 mirrorBase 作为 feedUrl（该目录需提供 electron-updater 的
 *   `latest.yml` / `latest-linux.yml` 与安装包）。
 */
export interface UpdateSourceConfig {
	source: 'github' | 'mirror';
	mirrorBase: string;
}

function normalize(input?: Partial<UpdateSourceConfig>): UpdateSourceConfig {
	const source = input?.source === 'mirror' ? 'mirror' : 'github';
	const mirrorBase = String(input?.mirrorBase ?? '')
		.trim()
		.replace(/\/+$/, '');
	if (source === 'mirror' && !/^https?:\/\//i.test(mirrorBase)) {
		throw new Error('镜像地址必须以 http(s):// 开头');
	}
	return { source, mirrorBase };
}

export function getUpdateSourceConfig(): UpdateSourceConfig {
	const raw = (store.store as Record<string, any>).update || {};
	return normalize(raw);
}

/** 保存更新源配置（electron-updater 的 feedUrl 由 tasks/updater.ts 读取本配置后应用） */
export function setUpdateSourceConfig(input: Partial<UpdateSourceConfig>): UpdateSourceConfig {
	const cfg = normalize(input);
	store.set('update', cfg);
	return cfg;
}
