import { store } from '../../store';
import { remote } from '../../utils/remote';

/**
 * 主动通知（DSH）随应用启动。
 *
 * 设置页把配置存在 `store.render.setting.dshNotify` 里；应用启动时如果开关打开，
 * 就拉起主进程的 watcher（失败只记日志，不打扰用户）。
 *
 * 上游 App.vue 只调用 `startDshNotifyIfEnabled()` 一行。
 */
export async function startDshNotifyIfEnabled(): Promise<void> {
	const cfg = store.render.setting.dshNotify;
	if (!cfg?.enabled || !cfg.botId || !cfg.targetId || !cfg.apiKey) {
		return;
	}
	try {
		const status = await remote.methods.call('dshBridgeStatus');
		const port = status?.remoteApi?.port || 15320;
		await remote.methods.call('dshNotifyStart', {
			ocsBase: `https://127.0.0.1:${port}`,
			apiKey: cfg.apiKey,
			certFingerprint: status?.remoteApi?.certFingerprint || '',
			botId: cfg.botId,
			targetId: cfg.targetId,
			deliveryUrl: cfg.deliveryUrl || undefined,
			intervalSec: cfg.intervalSec
		});
	} catch (err) {
		remote.logger.call('warn', 'DSH 通知自动启动失败：' + String(err)).catch(() => {});
	}
}
