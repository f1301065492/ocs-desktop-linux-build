import { Response } from 'express';
import { Logger } from '../../logger';

const logger = Logger('remote-api');

/**
 * SSE 事件广播器。
 *
 * 用 SSE 而不是 WebSocket：这是纯服务端→客户端的单向推送，SSE 基于普通 HTTP，
 * 调用方用 curl 就能看，浏览器里 `new EventSource(url)` 直接可用，
 * 不需要额外的握手协议和连接管理。
 */

/** 已连接的 SSE 客户端 */
const clients = new Set<Response>();

/** 心跳间隔。中间设备常会掐断长时间无数据的连接，定期发注释行保活 */
const HEARTBEAT_MS = 25 * 1000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function addClient(res: Response): void {
	clients.add(res);
	logger.info(`SSE 客户端接入，当前 ${clients.size} 个`);
	ensureHeartbeat();
}

export function removeClient(res: Response): void {
	if (clients.delete(res)) {
		logger.info(`SSE 客户端断开，当前 ${clients.size} 个`);
	}
	if (clients.size === 0) {
		stopHeartbeat();
	}
}

export function clientCount(): number {
	return clients.size;
}

/** 向所有客户端广播一个事件。没有客户端时直接返回，零开销 */
export function broadcast(event: string, data: unknown): void {
	if (clients.size === 0) {
		return;
	}
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const res of [...clients]) {
		try {
			res.write(payload);
		} catch {
			// 写入失败说明这条连接已经断了，清掉即可
			clients.delete(res);
		}
	}
}

function ensureHeartbeat(): void {
	if (heartbeatTimer) {
		return;
	}
	heartbeatTimer = setInterval(() => {
		for (const res of [...clients]) {
			try {
				// 以冒号开头的是 SSE 注释行，客户端会忽略，只起保活作用
				res.write(': heartbeat\n\n');
			} catch {
				clients.delete(res);
			}
		}
	}, HEARTBEAT_MS);
	// 不要让这个定时器拖住进程退出
	heartbeatTimer.unref?.();
}

function stopHeartbeat(): void {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}

/** 停止服务时断开所有客户端 */
export function closeAllClients(): void {
	for (const res of [...clients]) {
		try {
			res.end();
		} catch {
			// 连接早已断开，忽略
		}
	}
	clients.clear();
	stopHeartbeat();
}
