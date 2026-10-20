/**
 * 单独起一个「假 OCS」，用于本机手动试跑（不需要真 OCS，也不需要 OpenClaw）：
 *
 *   node test/serve-mock.mjs
 *
 * 它会打印可以直接复制走的 OCS_BASE / OCS_API_KEY / OCS_CERT_SHA256，
 * 另开一个终端就能拿这些变量去跑 ocs-mcp-server.mjs / ocs-watch.mjs。
 * 假数据里有：两个浏览器（一个运行中、一个已关闭）、一份带脱敏占位的日志、一张 1×1 截图。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockOcs, ensureTestCert, fingerprintOfPem } from './mock-ocs-server.mjs';

const API_KEY = 'mock-key-please-change';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-mock-'));
const { certPath, keyPath } = ensureTestCert(workDir);
const certPem = fs.readFileSync(certPath, 'utf8');
const keyPem = fs.readFileSync(keyPath, 'utf8');
const fingerprint = fingerprintOfPem(certPem);

const mock = await startMockOcs({ certPem, keyPem, apiKey: API_KEY });

console.log('假 OCS 已启动，按 Ctrl+C 结束。\n');
console.log(`  OCS_BASE=${mock.base}`);
console.log(`  OCS_API_KEY=${API_KEY}`);
console.log(`  OCS_CERT_SHA256=${fingerprint}\n`);
console.log('示例：');
console.log(`  node ocs-watch.mjs --once --state ./mock-state.json`);
console.log(`  OCS_BASE=... OCS_API_KEY=... node ocs-mcp-server.mjs   # 然后手动喂 JSON-RPC 行`);

// 每 20 秒往日志里追加一行，方便观察 ocs-watch 的增量播报
let tick = 0;
setInterval(() => {
	tick++;
	mock.appendLog('aaaaaaaa111122223333444455556666', `智慧树：检测到验证码，需要人工处理（第 ${tick} 次）\n`);
	console.log(`[mock] 已追加一行新日志（第 ${tick} 次）`);
}, 20000);
