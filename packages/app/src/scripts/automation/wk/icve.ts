import { Page } from 'playwright-core';
import { AutomationScript } from '../../script';

export const ICVELoginScript = new AutomationScript(
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
		name: '智慧职教-账号密码登录',
		icon: 'https://www.icve.com.cn/',
		async run(page, configs) {
			try {
				if (await isNotLogin(page)) {
					ICVELoginScript.emit('script-data', '智慧职教：开始账号密码登录');
					await page.fill('[placeholder="请输入账号"]', configs.username);
					await page.fill('[placeholder="请输入密码"]', configs.password);
					// 同意协议
					await page.click('.agreement label.el-checkbox');
					await page.click('form .login');
					// 这个站点提交后不做回检，只能上报到「已提交」这一步
					ICVELoginScript.emit('script-data', '智慧职教：已提交登录表单');
				}
			} catch (err) {
				ICVELoginScript.emit('script-error', String(err));
			}
		}
	}
);

async function isNotLogin(page: Page) {
	await page.goto('https://sso.icve.com.cn/sso/auth?mode=simple&source=2&redirect=https://mooc.icve.com.cn/cms/');
	await page.waitForTimeout(2000);
	return page.url().includes('sso/auth');
}
