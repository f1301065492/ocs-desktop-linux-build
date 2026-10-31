import { UpdateInformationResource } from '@ocs-desktop/common';
import { store } from '../store';
import { electron } from '../utils/node';
import { notify } from './notify';
import { Button, Modal, Notification, Progress } from '@arco-design/web-vue';
import { h } from 'vue';
import { marked } from 'marked';
import { remote } from './remote';
const { ipcRenderer, shell } = electron;

/** 更新弹窗/更新日志弹窗的 markdown 样式（注入一次，两处共用） */
export function ensureUpdaterChangelogStyle() {
	if (document.getElementById('updater-changelog-style')) {
		return;
	}
	const style = document.createElement('style');
	style.id = 'updater-changelog-style';
	style.textContent = `
		.update-changelog-content { max-height: 50vh; overflow-y: auto; margin-top: 8px; padding-right: 6px; }
		.update-changelog-content h2 { font-size: 15px; margin: 12px 0 4px; }
		.update-changelog-content h3 { font-size: 13px; margin: 8px 0 2px; }
		.update-changelog-content ul { padding-left: 18px; margin: 4px 0; }
		.update-changelog-content li { font-size: 13px; line-height: 1.7; }
		.update-changelog-content a { color: rgb(var(--primary-6)); cursor: pointer; }
	`;
	document.head.appendChild(style);
}

export function activeIpcRenderListener() {
	/** 如果正在更新的话，获取更新进度（带暂停/继续按钮） */
	let updatePaused = false;
	let updateLoaded = 0;
	let updateTotal = 0;
	/** 下载完成、进入安装阶段（此时暂停按钮失效，提示改为「正在安装」） */
	let updateInstalling = false;
	const renderUpdateProgress = () => {
		if (updateInstalling) {
			notify('OCS更新程序', '安装包下载完成，正在安装…（可能弹出系统密码框）', 'updater', {
				type: 'info',
				duration: 0,
				close: false,
				content: () => h('div', '安装包下载完成，正在安装…（可能弹出系统密码框，安装完成后会自动重启软件）')
			});
			return;
		}
		const percent = updateTotal > 0 ? updateLoaded / updateTotal : 0;
		const sizeText = `${(updateLoaded / 1024 / 1024).toFixed(2)}MB/${(updateTotal / 1024 / 1024).toFixed(2)}MB`;
		notify('OCS更新程序', `更新中: ${sizeText}`, 'updater', {
			type: 'info',
			duration: 0,
			close: false,
			content: () =>
				h('div', [
					h('div', `${updatePaused ? '已暂停' : '更新中'}: ${sizeText}`),
					h(Progress, {
						percent,
						size: 'small',
						showText: false,
						style: 'margin-top: 6px;'
					})
				]),
			btn:
				process.platform === 'linux'
					? h('div', { style: 'display:flex; justify-content:flex-end; gap:8px;' }, [
							h(
								Button,
								{
									size: 'mini',
									onClick: async () => {
										const next = !updatePaused;
										const ok = await remote.methods
											.call(next ? 'pauseUpdateDownload' : 'resumeUpdateDownload')
											.catch(() => false);
										if (ok) {
											updatePaused = next;
											renderUpdateProgress();
										}
									}
								},
								() => (updatePaused ? '继续下载' : '暂停下载')
							)
					  ])
					: undefined
		});
	};
	ipcRenderer.on('update-download', (e, rate, totalLength, chunkLength) => {
		updateTotal = totalLength;
		updateLoaded = chunkLength;
		renderUpdateProgress();
	});

	/** 下载完成，主进程开始安装（pkexec 会弹系统密码框）：把进度条换成「正在安装」 */
	ipcRenderer.on('update-installing', () => {
		updateInstalling = true;
		renderUpdateProgress();
	});

	/**
	 * 自动安装没成功（没有 pkexec / sudo NOPASSWD、或用户取消了密码框）：
	 * 收起「正在安装」通知，主进程随后会弹出「复制安装命令」的兜底弹窗
	 */
	ipcRenderer.on('update-install-failed', () => {
		updateInstalling = false;
		Notification.remove('updater');
	});

	// 显示浏览器
	ipcRenderer.on('show-browser-in-app', (e, uid) => {
		store.render.browser.currentBrowserUid = uid;
	});

	// 检测到新版本
	ipcRenderer.on('detect-new-app-version', (e, new_version: UpdateInformationResource) => {
		console.log('detect-new-app-version', new_version);
		if (!new_version) {
			return;
		}
		updatePaused = false;
		updateInstalling = false;
		updateLoaded = 0;
		updateTotal = 0;
		ensureUpdaterChangelogStyle();

		Modal.confirm({
			title: '🎉检测到版本更新：' + new_version.tag,
			titleAlign: 'center',
			okText: '确认更新',
			cancelText: '下次一定',
			maskClosable: false,
			width: 500,
			async onOk() {
				// 主进程只启动后台下载并立即返回，进度走 update-download 通知
				await remote.methods.call('updateApp', new_version).catch((err) => {
					console.error('启动更新失败', err);
				});
			},
			content: () =>
				h('div', [
					h('div', {
						class: 'update-changelog-content',
						innerHTML: marked.parse(new_version.markdown || '暂无更新日志'),
						// markdown 中的链接（commit/compare 链接）统一用系统浏览器打开
						onClick: (event: MouseEvent) => {
							const anchor = (event.target as HTMLElement).closest('a');
							if (anchor) {
								event.preventDefault();
								shell.openExternal(anchor.href);
							}
						}
					})
				])
		});
	});
}
