/**
 * 主动通知（DSH）在渲染进程 store 里的默认值与迁移。
 *
 * 上游 `store/index.ts` 只保留两处一行调用：
 *   - 默认值：`dshNotify: { ...DEFAULT_DSH_NOTIFY }`
 *   - 旧数据迁移：`migrateDshNotify(data)`
 */
export const DEFAULT_DSH_NOTIFY = {
	enabled: false,
	realtime: true,
	intervalSec: 5,
	botId: '',
	targetId: '',
	deliveryUrl: '',
	apiKey: ''
};

/** 旧版本数据里没有 dshNotify：解密后补默认值，避免设置页读到 undefined */
export function migrateDshNotify(data: any): void {
	if (data && data.setting) {
		data.setting.dshNotify = { ...DEFAULT_DSH_NOTIFY, ...(data.setting.dshNotify || {}) };
	}
}
