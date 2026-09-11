import { Request, Response, NextFunction } from 'express';
import { getRemoteApiConfig, verifyApiKey } from './config';
import { ApiError, fail } from './errors';

/** 鉴权失败计数窗口 */
const FAIL_WINDOW_MS = 60 * 1000;
/** 单个 IP 在窗口内允许的鉴权失败次数 */
const FAIL_MAX = 20;

/** key: ip，value: 失败时间戳列表 */
const failures = new Map<string, number[]>();

function clientIp(req: Request): string {
	// 不信任 X-Forwarded-For：默认取 socket 地址，避免伪造头绕过限流
	return req.ip || req.socket.remoteAddress || 'unknown';
}

function pruneFailures(ip: string, now: number): number[] {
	const list = (failures.get(ip) ?? []).filter((ts) => now - ts < FAIL_WINDOW_MS);
	failures.set(ip, list);
	return list;
}

/** 该 IP 是否因失败次数过多被临时拒绝 */
export function isAuthRateLimited(req: Request): boolean {
	const now = Date.now();
	return pruneFailures(clientIp(req), now).length >= FAIL_MAX;
}

function recordAuthFailure(req: Request): void {
	const now = Date.now();
	const list = pruneFailures(clientIp(req), now);
	list.push(now);
	failures.set(clientIp(req), list);
}

/** 从 X-API-Key 或 Authorization: Bearer 中取出密钥 */
function extractKey(req: Request): string | undefined {
	const direct = req.get('x-api-key');
	if (direct && direct.trim()) {
		return direct.trim();
	}
	const authorization = req.get('authorization');
	if (authorization) {
		const match = authorization.match(/^Bearer\s+(.+)$/i);
		if (match) {
			return match[1].trim();
		}
	}
	return undefined;
}

/**
 * API 密钥校验中间件。
 *
 * 缺失与错误统一返回 401 且文案一致，避免通过响应差异枚举密钥是否有效。
 * 不加 WWW-Authenticate：这是给程序调的 API，不该触发浏览器原生登录框。
 */
export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
	const requestId = (req as Request & { requestId?: string }).requestId ?? '';
	try {
		if (!getRemoteApiConfig().enabled) {
			// 用 404 而非 403：不向未授权方暴露"这里存在一个 API"
			throw new ApiError('NOT_ENABLED', '远程 API 未开启');
		}

		if (isAuthRateLimited(req)) {
			res.status(429).json(fail(new ApiError('UNAUTHORIZED', '尝试次数过多，请稍后再试'), requestId));
			return;
		}

		const provided = extractKey(req);
		const matched = await verifyApiKey(provided);
		if (!matched) {
			recordAuthFailure(req);
			res.status(401).json(fail(new ApiError('UNAUTHORIZED', 'API 密钥无效'), requestId));
			return;
		}

		next();
	} catch (err) {
		if (err instanceof ApiError) {
			res.status(err.status).json(fail(err, requestId));
			return;
		}
		res.status(500).json(fail(new ApiError('INTERNAL', '服务器内部错误'), requestId));
	}
}
