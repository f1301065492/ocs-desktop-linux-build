/**
 * 远程 API 的错误码与 HTTP 状态映射。
 *
 * 统一响应体：
 *   成功 { data, requestId }
 *   失败 { error: { code, message, details? }, requestId }
 */

export type ApiErrorCode =
	| 'UNAUTHORIZED'
	| 'NOT_ENABLED'
	| 'INVALID_ARGUMENT'
	| 'INVALID_JSON'
	| 'UNKNOWN_FIELD'
	| 'BROWSER_NOT_FOUND'
	| 'TASK_NOT_FOUND'
	| 'PARENT_NOT_FOUND'
	| 'PARENT_NOT_FOLDER'
	| 'UNKNOWN_AUTOMATION_SCRIPT'
	| 'ALREADY_RUNNING'
	| 'BROWSER_BUSY'
	| 'NOT_RUNNING'
	| 'EXECUTABLE_PATH_NOT_SET'
	// 启动流程走完了但浏览器没进入运行状态（进程起来了又立刻退出等）
	| 'LAUNCH_FAILED'
	| 'RENDERER_UNAVAILABLE'
	| 'LAUNCH_TIMEOUT'
	| 'CLOSE_TIMEOUT'
	// 以下来自子进程（ScriptWorker）截图/页面查询链路
	| 'PAGE_NOT_FOUND'
	| 'NO_PAGE'
	| 'WORKER_TIMEOUT'
	| 'WORKER_ERROR'
	| 'INTERNAL';

const HTTP_STATUS: Record<ApiErrorCode, number> = {
	UNAUTHORIZED: 401,
	// 未开启时返回 404 而不是 403，避免向未授权方暴露"这里存在一个 API"
	NOT_ENABLED: 404,
	INVALID_ARGUMENT: 400,
	INVALID_JSON: 400,
	UNKNOWN_FIELD: 400,
	BROWSER_NOT_FOUND: 404,
	TASK_NOT_FOUND: 404,
	PARENT_NOT_FOUND: 422,
	PARENT_NOT_FOLDER: 422,
	UNKNOWN_AUTOMATION_SCRIPT: 422,
	ALREADY_RUNNING: 409,
	BROWSER_BUSY: 409,
	NOT_RUNNING: 409,
	EXECUTABLE_PATH_NOT_SET: 412,
	// 不是调用方的问题，而是本机环境/浏览器本身起不来
	LAUNCH_FAILED: 500,
	RENDERER_UNAVAILABLE: 503,
	LAUNCH_TIMEOUT: 504,
	CLOSE_TIMEOUT: 504,
	// 没有匹配的页面是「找不到资源」，用 404；
	// 浏览器一个页面都没有属于状态冲突，用 409 更准确
	PAGE_NOT_FOUND: 404,
	NO_PAGE: 409,
	WORKER_TIMEOUT: 504,
	WORKER_ERROR: 500,
	INTERNAL: 500
};

export class ApiError extends Error {
	readonly code: ApiErrorCode;
	readonly details?: unknown;

	constructor(code: ApiErrorCode, message: string, details?: unknown) {
		super(message);
		this.name = 'ApiError';
		this.code = code;
		this.details = details;
	}

	get status(): number {
		return HTTP_STATUS[this.code] ?? 500;
	}
}

/**
 * 把任意异常规整成 ApiError。
 * 未知异常一律归为 INTERNAL 且不回传原始信息，避免把栈、绝对路径等内部细节泄漏出去。
 */
export function toApiError(err: unknown): ApiError {
	if (err instanceof ApiError) {
		return err;
	}
	return new ApiError('INTERNAL', '服务器内部错误');
}

/** 构造成功响应体 */
export function ok<T>(data: T, requestId: string) {
	return { data, requestId };
}

/** 构造失败响应体 */
export function fail(err: ApiError, requestId: string) {
	return {
		error: {
			code: err.code,
			message: err.message,
			...(err.details === undefined ? {} : { details: err.details })
		},
		requestId
	};
}
