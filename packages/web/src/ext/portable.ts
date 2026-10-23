import { h, ref } from 'vue';
import { Message, Modal, InputPassword } from '@arco-design/web-vue';
import { remote } from '../utils/remote';

/**
 * 数据导出 / 导入的可移植格式（扩展功能）。
 *
 * 本机密钥链格式只能在原机器解密，换电脑会失败；可移植格式用导出口令派生密钥，
 * 换机器输入同一口令即可。主进程实现见 `packages/app/src/ext/portable.ts`。
 *
 * 上游 Title.vue 只保留两处调用：`decryptImportedRender` / `askExportPassword`。
 */

/** 与主进程 PORTABLE_PREFIX 保持一致 */
export const PORTABLE_PREFIX = 'ocsdata:v2:';

/** 弹窗输入密码；取消返回 null */
function askPassword(title: string, tip: string): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const password = ref('');
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		Modal.open({
			title,
			content: () =>
				h('div', [
					h('div', { style: 'margin-bottom: 8px; color: var(--color-text-3); font-size: 12px;' }, tip),
					h(InputPassword, {
						modelValue: password.value,
						placeholder: '至少 4 个字符',
						'onUpdate:modelValue': (value: string) => {
							password.value = value;
						}
					})
				]),
			okText: '确定',
			cancelText: '取消',
			onOk: () => {
				if (password.value.trim().length < 4) {
					Message.warning('密码至少 4 个字符');
					return false;
				}
				finish(password.value);
				return true;
			},
			onCancel: () => finish(null),
			onClose: () => finish(null)
		});
	});
}

/**
 * 解密导入的数据。
 *
 * - 可移植格式：让用户输入导出密码；
 * - 旧格式：用本机密钥链解密，跨机器会失败并给出明确提示。
 *
 * 返回 null 表示用户取消或解密失败（此时已经提示过用户）。
 */
export async function decryptImportedRender(renderStr: string): Promise<any | null> {
	if (renderStr.startsWith(PORTABLE_PREFIX)) {
		const password = await askPassword('输入导出密码', '这份数据是用密码加密的，请输入导出时设置的密码。');
		if (!password) {
			Message.warning('已取消导入');
			return null;
		}
		try {
			return JSON.parse(remote.methods.callSync('decryptPortable' as any, renderStr, password) as string);
		} catch {
			Message.error('密码错误或数据已损坏，无法解密');
			return null;
		}
	}
	// 旧格式：用本机密钥链的 AES 密钥解密，只能在同一台机器/同一用户下使用
	try {
		return JSON.parse(remote.methods.callSync('decryptRenderString' as any, renderStr) as string);
	} catch {
		Message.error(
			'这份数据是用导出电脑的本地密钥加密的，当前电脑无法解密。' +
				'请在原电脑升级到新版后重新导出（会提示设置密码），再到这里导入。'
		);
		return null;
	}
}

/** 导出前让用户设置口令；取消返回 null */
export function askExportPassword(): Promise<string | null> {
	return askPassword('设置导出密码', '换电脑导入时需要输入这个密码；请妥善保存，忘记后无法恢复。');
}

/** 用口令加密 render 数据（可跨机器解密） */
export function encryptRenderForExport(render: unknown, password: string): string {
	return remote.methods.callSync('encryptPortable' as any, JSON.stringify(render), password) as string;
}
