import { Page } from 'playwright-core';
import { breakSliderVerify, getBase64 } from '../../utils';
import { AutomationScript } from '../../script';

/**
 * 智慧树登录（2026-10 页面改版后）
 *
 * 首页的「登录 / 注册」入口 `#notLogin` 现在会跳到 `login.zhihuishu.com` 的登录中心，
 * 表单换成了 Element Plus 结构：
 * - 手机号 / 用户名：`input[name="mobile"]`
 * - 密码：`input[type="password"]`
 * - 「我已阅读并同意…」：`label.privacy-checkbox input[type="checkbox"]`（默认未勾）
 * - 提交：`.login-bottom .base-button-component`
 * - 学号登录 tab：`#tab-2`，学校是 Element Plus 下拉（`.el-select` → 输入 → `.el-select-dropdown__item`），学号 `input[name="unid"]`
 *
 * 改版前那套 `#qSignin` / `#lUsername` / `#lPassword` / `#quickSearch` / `#clCode` /
 * `#clPassword` / `.wall-sub-btn` 已经**全部不存在**，照旧用它们只会一路超时，
 * 表现为“启动浏览器后账号密码填不进去”。
 *
 * 验证码仍是网易易盾（`input.yidun_input[name="NECaptchaValidate"]`），滑块逻辑不变。
 */
const LOGIN_PAGE_HOST = 'login.zhihuishu.com';
const LOGIN_SUBMIT_SELECTOR = '.login-bottom .base-button-component, .btn-block__grandient_login';
const PRIVACY_CHECKBOX_SELECTOR = 'label.privacy-checkbox input[type="checkbox"]';

export const ZHSUnitLoginScript = new AutomationScript(
	{
		schoolname: {
			label: '学校',
			value: '',
			type: 'text',
			required: true,
			placeholder: '请输入学校名称'
		},
		id: {
			label: '学号',
			value: '',
			type: 'text',
			required: true,
			placeholder: '请输入学号'
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
		name: '智慧树-学校登录',
		icon: 'https://www.zhihuishu.com/',
		async run(
			page,
			configs,
			options?: {
				ocrApiUrl?: string;
				detTargetKey?: string;
				detBackgroundKey?: string;
			}
		) {
			try {
				if (await isNotLogin(page)) {
					// 切到「学号登录」tab
					await page.click('#tab-2');
					await page.waitForTimeout(1500);

					// 学校是个下拉：点开 → 输入学校名 → 点第一个候选项
					await page.click('.el-select');
					await page.waitForTimeout(500);
					await page.keyboard.type(configs.schoolname, { delay: 100 });
					await page.waitForSelector('.el-select-dropdown__item', { timeout: 30 * 1000 });
					await page.waitForTimeout(1500);
					await page.click('.el-select-dropdown__item');

					await page.fill('input[name="unid"]', configs.id);
					await page.fill('input[type="password"]', configs.password);
					await acceptPrivacy(page);
					await page.waitForTimeout(3000);
					await page.click(LOGIN_SUBMIT_SELECTOR);

					if (options?.ocrApiUrl && options?.detTargetKey && options?.detBackgroundKey) {
						let count = 5;
						while (await isNotVerified(page)) {
							if (count > 0) {
								count--;
								await verify(page, {
									ocrApiUrl: options.ocrApiUrl,
									detTargetKey: options.detTargetKey,
									detBackgroundKey: options.detBackgroundKey
								});

								await page.waitForTimeout(2000);
							} else {
								throw new Error('滑块识别失败，请手动登录。');
							}
						}
					}
				}
			} catch (err) {
				ZHSUnitLoginScript.emit('script-error', String(err));
			}
		}
	}
);

export const ZHSPhoneLoginScript = new AutomationScript(
	{
		phone: {
			label: '手机号',
			value: '',
			type: 'text',
			required: true,
			placeholder: '请输入手机号'
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
		name: '智慧树-手机密码登录',
		icon: 'https://www.zhihuishu.com/',
		async run(
			page,
			configs,
			options?: {
				ocrApiUrl?: string;
				detTargetKey?: string;
				detBackgroundKey?: string;
			}
		) {
			try {
				if (await isNotLogin(page)) {
					// 默认就是「账号登录」tab，这里显式点一次；点不动（比如又改版）也不影响后面按选择器填
					await page.click('#tab-1\\.1').catch(() => {});
					await page.waitForTimeout(1000);

					await page.fill('input[name="mobile"]', configs.phone);
					await page.fill('input[type="password"]', configs.password);
					await acceptPrivacy(page);
					await page.waitForTimeout(3000);
					await page.click(LOGIN_SUBMIT_SELECTOR);

					if (options?.ocrApiUrl && options?.detTargetKey && options?.detBackgroundKey) {
						let count = 5;
						while ((await isNotVerified(page)) && count > 0) {
							count--;
							await verify(page, {
								ocrApiUrl: options.ocrApiUrl,
								detTargetKey: options.detTargetKey,
								detBackgroundKey: options.detBackgroundKey
							});

							await page.waitForTimeout(2000);
						}
					}
				}
			} catch (err) {
				ZHSPhoneLoginScript.emit('script-error', String(err));
			}
		}
	}
);

/**
 * 滑块验证
 */
async function verify(page: Page, opts: { ocrApiUrl: string; detTargetKey: string; detBackgroundKey: string }) {
	// 删除yidun遮挡
	await page.evaluate(() =>
		document.querySelectorAll('.yidun_cover-frame,.yidun_popup__mask').forEach((el) => el.remove())
	);

	const det_slider_el = await page.$('.yidun_slider');
	const det_target_el = await page.$('[alt="验证码滑块"]');
	const det_bg_el = await page.$('[alt="验证码背景"]');

	if (det_target_el && det_slider_el && det_bg_el) {
		const det_target_src = await det_target_el.getAttribute('src');
		const det_bg_src = await det_bg_el.getAttribute('src');
		if (det_target_src && det_bg_src) {
			await breakSliderVerify(page, det_slider_el, await getBase64(det_target_src), await getBase64(det_bg_src), {
				...opts,
				offset: 10
			});
		}
	}
}

/**
 * 是否仍未登录成功。
 *
 * 登录中心在 login.zhihuishu.com，登录成功后页面会跳走；页面上出现表单校验 / 服务端提示的错误时直接抛出去，
 * 免得把一个明确的失败（密码错误、需要验证码等）拖到最后变成“滑块识别失败”。
 */
async function isNotVerified(page: Page) {
	await page.waitForTimeout(2000);

	const errors = await page.evaluate(() =>
		Array.from(document.querySelectorAll('.el-form-item__error, .el-message__content'))
			.map((e) => (e.textContent || '').trim())
			.filter(Boolean)
	);

	if (errors.length) {
		throw new Error(errors.join('\n'));
	}

	return page.url().includes(LOGIN_PAGE_HOST);
}

/**
 * 是否未登录；未登录时顺带点开登录中心并把表单等出来。
 *
 * 首页未登录时「登录 / 注册」入口 `#notLogin` 可见（已登录则是 `#login` 那块用户信息区），
 * 点它会跳到 login.zhihuishu.com。
 */
async function isNotLogin(page: Page) {
	await page.goto('https://www.zhihuishu.com/');
	await page.waitForTimeout(2000);

	const notLogin = await page.evaluate(() => {
		const el = document.querySelector('#notLogin') as HTMLElement | null;
		return !!el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
	});

	if (notLogin) {
		await page.click('#notLogin');
		// 登录页加载出来之前就 fill 的话会直接超时，这里先把表单等出来
		await page.waitForSelector('input[name="mobile"], #tab-2', { timeout: 60 * 1000 });
		await page.waitForTimeout(2000);
	}

	return notLogin;
}

/**
 * 勾选「我已阅读并同意《智慧树用户协议》《隐私政策》…」
 *
 * 原生 checkbox 被 Element Plus 隐藏，Playwright 的 check() 会因为元素不可见而超时，
 * 只能直接对它派发原生 click；先看当前状态，避免把已勾选的又点掉。
 */
async function acceptPrivacy(page: Page) {
	await page.evaluate((selector) => {
		const input = document.querySelector(selector) as HTMLInputElement | null;
		if (input && !input.checked) {
			input.click();
		}
	}, PRIVACY_CHECKBOX_SELECTOR);
}
