import { store } from '../store';
import { remote } from './remote';
import { root } from '../fs/folder';

/**
 * 持久化存储。
 *
 * 从 App.vue 抽出来共享：远程 API 创建浏览器后必须主动落盘，
 * 否则要等 App.vue 里 100ms 防抖的 watch 才写入，
 * 调用方拿到 201 时数据其实还在内存里。
 */

/** 异步保存，用于实时持久化（单次 IPC 调用，加密+写入在主进程完成） */
export async function saveStoreToLocal(_store: typeof store) {
	try {
		const shouldEncrypt = remote.methods.callSync('isEncryptionAvailable');
		await remote.methods.call('saveStore', JSON.stringify(_store), shouldEncrypt);
	} catch (e) {
		console.error(e);
	}
}

/** 同步版本保存，用于关闭或需要立即落盘的场景（单次 IPC 调用） */
export function saveStoreToLocalSync(_store: typeof store) {
	try {
		const shouldEncrypt = remote.methods.callSync('isEncryptionAvailable');
		remote.methods.callSync('saveStore', JSON.stringify(_store), shouldEncrypt);
	} catch (e) {
		console.error(e);
	}
}

/**
 * 把响应式文件树同步回 store 并立即落盘。
 *
 * 必须显式赋值：folder.ts 里把 _root 同步回 store.render.browser.root 的 watch
 * 是 pre 刷新时机（微任务），同步调用后立刻保存会拿到旧数据。
 */
export async function persistBrowserTree(): Promise<void> {
	store.render.browser.root = JSON.parse(JSON.stringify(root()));
	await saveStoreToLocal(store);
}
