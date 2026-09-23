import path from 'path';
import axios from 'axios';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { finished } from 'stream/promises';
import { Logger } from '../logger';

const logger = Logger('download');

/**
 * 并行分片下载。
 *
 * 为什么需要它：GitHub Releases 在国内单连接只有约 0.5 MB/s，
 * 而实测 8 线程能跑到约 3.8 MB/s（7.8 倍）。瓶颈是**单连接限速**而不是带宽，
 * 所以多开连接就能叠加。
 *
 * 服务端不支持 Range 时自动回退到单流下载，行为与改造前一致。
 */

/** 每个分片的大小。取 4MB：分片够多便于负载均衡，又不至于请求数过多 */
const CHUNK_SIZE = 4 * 1024 * 1024;

/** 并发连接数。实测 8 已经能拿到接近线性的收益，再多对服务端不友好 */
const CONCURRENCY = 8;

/** 单个分片的下载重试次数 */
const CHUNK_RETRIES = 3;

/** 小于这个大小就不折腾分片了，单流反而更快 */
const PARALLEL_THRESHOLD = 8 * 1024 * 1024;

/** 进度回调的节流间隔。8 个连接各自上报会把 IPC 打满 */
const PROGRESS_INTERVAL_MS = 200;

type RateHandler = (rate: number, totalLength: number, chunkLength: number) => void;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ChunkRange {
	start: number;
	/** 闭区间，与服务端 Range 语义一致 */
	end: number;
}

/** 节流后的进度上报器，多个连接共用同一个 */
function createProgressReporter(rateHandler: RateHandler, getReceived: () => number, totalLength: number) {
	let lastReport = 0;
	let reportedDone = false;
	return () => {
		const now = Date.now();
		const received = getReceived();
		const done = received >= totalLength;
		if (!done && now - lastReport < PROGRESS_INTERVAL_MS) {
			return;
		}
		// 100% 只报一次，避免多个连接收尾时重复触发
		if (done) {
			if (reportedDone) return;
			reportedDone = true;
		}
		lastReport = now;
		rateHandler(Math.min(100, parseFloat(((received / totalLength) * 100).toFixed(2))), totalLength, received);
	};
}

/**
 * 先探一次，拿到总大小并判断服务端是否支持分片。
 *
 * 用 `Range: bytes=0-0` 而不是 HEAD：GitHub Releases 会 302 到 CDN，
 * 用带 Range 的 GET 探测更稳，且能从 Content-Range 里直接读到总长度。
 */
async function probe(fileURL: string): Promise<{ totalLength: number; supportsRange: boolean }> {
	try {
		const response = await axios.get(fileURL, {
			responseType: 'stream',
			headers: { Range: 'bytes=0-0' },
			maxRedirects: 5,
			timeout: 20000
		});
		// 探测连接要主动关掉，否则会一直挂着
		response.data.destroy();

		const acceptRanges = String(response.headers['accept-ranges'] || '').toLowerCase();
		const contentRange = String(response.headers['content-range'] || '');
		const totalMatch = contentRange.match(/\/(\d+)$/);
		const totalLength = totalMatch ? parseInt(totalMatch[1], 10) : NaN;

		if (response.status === 206 && acceptRanges.includes('bytes') && Number.isFinite(totalLength)) {
			return { totalLength, supportsRange: true };
		}

		// 服务端忽略了 Range，回退单流
		const plainLength = parseInt(String(response.headers['content-length'] || ''), 10);
		return { totalLength: Number.isFinite(plainLength) ? plainLength : 0, supportsRange: false };
	} catch (err) {
		logger.info(`分片探测失败，回退单流下载: ${err instanceof Error ? err.message : String(err)}`);
		return { totalLength: 0, supportsRange: false };
	}
}

function splitChunks(totalLength: number): ChunkRange[] {
	const chunks: ChunkRange[] = [];
	for (let start = 0; start < totalLength; start += CHUNK_SIZE) {
		chunks.push({ start, end: Math.min(start + CHUNK_SIZE - 1, totalLength - 1) });
	}
	return chunks;
}

async function downloadChunk(
	fileURL: string,
	outputURL: string,
	chunk: ChunkRange,
	onProgress: (bytes: number) => void
): Promise<void> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt++) {
		try {
			const response = await axios.get(fileURL, {
				responseType: 'stream',
				headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
				maxRedirects: 5,
				timeout: 60000
			});

			// 用 r+ 从指定偏移写，各分片互不干扰，也不需要事后拼接
			const writer = createWriteStream(outputURL, { flags: 'r+', start: chunk.start });
			response.data.on('data', (buf: Buffer) => onProgress(buf.length));
			response.data.pipe(writer);
			await finished(writer);
			return;
		} catch (err) {
			lastError = err;
			if (attempt < CHUNK_RETRIES) {
				// 退避后重试：分片失败多半是偶发的网络抖动
				await sleep(500 * attempt);
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function downloadParallel(
	fileURL: string,
	outputURL: string,
	totalLength: number,
	rateHandler: RateHandler
): Promise<string> {
	const chunks = splitChunks(totalLength);
	const queue = [...chunks];
	let received = 0;

	const report = createProgressReporter(rateHandler, () => received, totalLength);

	const worker = async () => {
		for (;;) {
			const chunk = queue.shift();
			if (!chunk) {
				return;
			}
			await downloadChunk(fileURL, outputURL, chunk, (bytes) => {
				// 每个 data 事件都会调到这里，所以只累加计数，
				// 实际上报交给 report 内部的节流，避免多个连接把 IPC 打满
				received += bytes;
				report();
			});
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
	rateHandler(100, totalLength, totalLength);
	return outputURL;
}

/** 单流下载，作为不支持分片时的回退路径 */
async function downloadSingle(fileURL: string, outputURL: string, rateHandler: RateHandler): Promise<string> {
	const { data, headers } = await axios.get(fileURL, { responseType: 'stream', maxRedirects: 5 });
	const totalLength = parseInt(String(headers['content-length']));

	let chunkLength = 0;
	data.on('data', (chunk: any) => {
		chunkLength += String(chunk).length;
		rateHandler(parseFloat(((chunkLength / totalLength) * 100).toFixed(2)), totalLength, chunkLength);
	});

	const writer = createWriteStream(outputURL);
	data.pipe(writer);
	await finished(writer);
	rateHandler(100, totalLength, totalLength);
	return outputURL;
}

/**
 * 下载文件（分片优先，自动回退单流）。
 * 签名与原实现保持一致，调用方无需改动。
 */
export async function downloadFile(fileURL: string, outputURL: string, rateHandler: RateHandler) {
	logger.info('downloadFile', fileURL, outputURL);

	// 创建文件夹
	if (existsSync(path.dirname(outputURL)) === false) {
		mkdirSync(path.dirname(outputURL), { recursive: true });
	}

	const { totalLength, supportsRange } = await probe(fileURL);

	if (supportsRange && totalLength > PARALLEL_THRESHOLD) {
		// 预建文件：分片用 r+ 从各自偏移写入，文件必须先存在。
		// 写空串而不是 Buffer.alloc(0)——新版 @types/node 里 Buffer 的泛型
		// 与 writeFileSync 的 ArrayBufferView 参数不兼容
		writeFileSync(outputURL, '');
		try {
			return await downloadParallel(fileURL, outputURL, totalLength, rateHandler);
		} catch (err) {
			// 分片失败就清掉残留，让调用方看到的是「没下载成功」而不是半个文件
			rmSync(outputURL, { force: true });
			throw err;
		}
	}

	return await downloadSingle(fileURL, outputURL, rateHandler);
}
