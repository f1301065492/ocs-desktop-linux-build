import { Page } from 'playwright-core';
import { AutomationScript } from '../../script';

export const ZJYLoginScript = new AutomationScript(
	{
		username: {
			label: '账号',
			value: '',
			type: 'text',
			required: true,
			placeholder: '请输入账号'
		},
		password: {
			label: '密码',
			value: '',
			type: 'password',
			required: true,
			placeholder: '请输入密码'
		}
	},
	{
		name: '职教云-账号密码登录',
		icon: 'https://zjy2.icve.com.cn/',
		async run(page, configs) {
			try {
				await page.goto('https://zjy2.icve.com.cn/study/index');
				if (await isNotLogin(page)) {
					ZJYLoginScript.emit('script-data', '职教云：开始账号密码登录');
					await page.fill('[placeholder="请输入账号"]', configs.username);
					await page.fill('[placeholder="请输入密码"]', configs.password);
					await page.click('.agreement .el-checkbox__input');
					await page.click('.ri .login', { position: { x: 10, y: 10 } });
					ZJYLoginScript.emit('script-data', '职教云：已提交登录表单');
					await page.waitForTimeout(1000);
					if (await isNotLogin(page)) {
						const errors = await page.evaluate(() =>
							Array.from(document.querySelectorAll('.xcConfirm .txtBox'))
								.map((e) => e.textContent || '')
								.filter(Boolean)
						);

						if (errors.length) {
							throw new Error(errors.join('\n'));
						}
						ZJYLoginScript.emit('script-data', '职教云：登录后仍停在登录页，可能需要人工处理');
					} else {
						ZJYLoginScript.emit('script-data', '职教云：登录成功');
					}
				}
			} catch (err) {
				ZJYLoginScript.emit('script-error', String(err));
			}
		}
	}
);

/** 是否未登录 */
async function isNotLogin(page: Page) {
	return page.url().includes('/sso/auth');
}
