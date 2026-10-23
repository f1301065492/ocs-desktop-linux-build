import { store } from '../../store';

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

/** 保存更新源，并同步给上游 electron-updater 的 feedUrl */
export function setUpdateSourceConfig(input: Partial<UpdateSourceConfig>): UpdateSourceConfig {
	const cfg = normalize(input);
	store.set('update', cfg);
	// [ocs-ext] electron-updater 通过 store.updater.feedUrl 使用自定义源
	const current = (store.store as Record<string, any>).updater || {};
	store.set('updater', {
		...current,
		feedUrl: cfg.source === 'mirror' ? cfg.mirrorBase : ''
	});
	return cfg;
}
