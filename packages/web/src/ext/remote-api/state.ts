import { reactive } from 'vue';
import { remote } from '../../utils/remote';

/**
 * 「远程 API」与「SSH 反向隧道」两张卡片共用的状态。
 *
 * 为什么需要它：隧道那张卡片要在远程 API 未开启时给出提示，但它起初是自己
 * 在 onMounted 里读一次 API 状态并缓存——用户在它上方的卡片里开启 API 之后，
 * 它仍然拿着开页时的旧值，于是一直显示「远程 API 当前未开启」。
 *
 * 这里放一份模块级 reactive 单例，由 API 卡片负责刷新，隧道卡片只读，
 * 两边就不会各自缓存、各自过期。
 */
export const remoteApiState = reactive({
	/** 远程 API 是否已开启 */
	enabled: false,
	/** 是否已经成功读到过一次状态（用于区分「确实没开」和「还没读到」） */
	loaded: false
});

/** 重新读取远程 API 状态。失败时保持原值，不打断界面 */
export async function refreshRemoteApiState(): Promise<void> {
	try {
		const status = await remote.methods.call('remoteApiGetStatus');
		remoteApiState.enabled = Boolean(status && status.enabled);
		remoteApiState.loaded = true;
	} catch {
		// 主进程尚未就绪或通道异常时忽略；下次刷新会补上
	}
}
