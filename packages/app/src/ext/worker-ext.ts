import type { BrowserContext, Page } from 'playwright-core';

/**
 * 供远程 API 使用的 worker 能力（扩展功能）。
 *
 * 这些方法原本直接写在 ScriptWorker 里，抽出来后 worker 只保留一行委托，
 * 方便对照上游更新。IPC 是单向的，结果通过 `send` 回传并带上 requestId。
 */

type SendFn = (event: string, ...args: any[]) => void;

/**
 * 列出当前打开的所有页面。
 *
 * 父进程可能并发发起多个请求，靠 requestId 区分回执归属。
 */
export async function listPagesExt(
	browser: BrowserContext | undefined,
	send: SendFn,
	options: { requestId: string }
) {
	const { requestId } = options;
	try {
		const pages = browser?.pages() ?? [];
		const list = await Promise.all(
			pages.map(async (page, index) => ({
				index,
				url: page.url(),
				title: await page.title().catch(() => '')
			}))
		);
		send('pages-result', { requestId, data: { pages: list } });
	} catch (err) {
		send('pages-result', { requestId, error: toWorkerError(err) });
	}
}

/**
 * 按需截取某个页面的画面。
 *
 * 用 page.screenshot() 而不是主进程的 desktopCapturer：前者截的是页面内容，
 * 窗口被最小化或被其他窗口遮挡时依然能截到，更适合服务端无人值守的场景。
 */
export async function screenshotPageExt(
	browser: BrowserContext | undefined,
	send: SendFn,
	options: {
		requestId: string;
		/** 目标页 URL 片段，不传则取最后一个页面 */
		pageUrl?: string;
		format?: 'png' | 'jpeg';
		quality?: number;
		fullPage?: boolean;
	}
) {
	const { requestId, pageUrl, format, quality, fullPage } = options;
	try {
		const pages = browser?.pages() ?? [];
		if (pages.length === 0) {
			send('screenshot-result', {
				requestId,
				error: { code: 'NO_PAGE', message: '浏览器当前没有打开的页面' }
			});
			return;
		}

		// 书签导航页是第一个页面，自动化脚本打开的业务页在后面，所以默认取最后一个
		const page = pageUrl ? pages.find((p) => p.url().includes(pageUrl)) : pages[pages.length - 1];
		if (!page) {
			send('screenshot-result', {
				requestId,
				error: {
					code: 'PAGE_NOT_FOUND',
					message: `没有匹配 "${pageUrl}" 的页面，可用页面: ${pages.map((p) => p.url()).join(' | ')}`
				}
			});
			return;
		}

		const type = format === 'png' ? 'png' : 'jpeg';
		const buffer = await page.screenshot({
			type,
			// quality 只对 jpeg 有效，传给 png 会被 Playwright 拒绝
			...(type === 'jpeg' ? { quality: clampQuality(quality) } : {}),
			fullPage: Boolean(fullPage)
		});

		send('screenshot-result', {
			requestId,
			data: {
				base64: buffer.toString('base64'),
				mimeType: type === 'png' ? 'image/png' : 'image/jpeg',
				size: buffer.length,
				url: page.url(),
				title: await page.title().catch(() => '')
			}
		});
	} catch (err) {
		send('screenshot-result', { requestId, error: toWorkerError(err) });
	}
}

/**
 * 把异常整理成可跨 IPC 回传的纯对象。
 *
 * 必须回传纯对象而不是 Error 实例：父进程的 shell.on('message') 是结构化克隆，
 * 且这里的错误最终要变成对外 API 的错误码，字符串对最省事也最不容易出意外。
 */
function toWorkerError(err: unknown): { code: string; message: string } {
	const code = (err as { code?: unknown })?.code;
	return {
		code: typeof code === 'string' && code ? code : 'WORKER_ERROR',
		message: err instanceof Error ? err.message : String(err)
	};
}

/** jpeg 质量钳制在 Playwright 允许的 0-100 区间内 */
function clampQuality(quality: number | undefined): number {
	if (typeof quality !== 'number' || !Number.isFinite(quality)) {
		return 70;
	}
	return Math.min(100, Math.max(0, Math.round(quality)));
}

export type { Page };
