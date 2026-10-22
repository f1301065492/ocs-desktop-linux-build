/**
 * 本机自测：起一个「假 OCS」（HTTPS + 自签证书），把 ocs-client / ocs-mcp-server / ocs-watch
 * 真跑一遍并断言结果。不需要真实的 OCS，也不需要 OpenClaw。
 *
 *   node test/run.mjs
 *
 * 需要 Node 20+；生成测试证书需要 openssl（Git for Windows 自带）。
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startMockOcs, ensureTestCert, fingerprintOfPem } from './mock-ocs-server.mjs';
import { loadConfig, OcsApi } from '../ocs-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(HERE, '..', 'ocs-mcp-server.mjs');
const WATCH = path.join(HERE, '..', 'ocs-watch.mjs');
const API_KEY = 'test-key-0123456789';
const UID = 'aaaaaaaa111122223333444455556666';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
	}
}
function checkMatch(name, actual, re) {
	const ok = typeof actual === 'string' && re.test(actual);
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}\n      期望匹配: ${re}\n      实际: ${JSON.stringify(actual)}`);
	}
}

/** 起一个 MCP 子进程并按行收发 JSON-RPC */
function startMcp(env) {
	const child = spawn(process.execPath, [MCP_SERVER], {
		env: { ...process.env, ...env },
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const pending = new Map();
	const stderrLines = [];
	let buffer = '';
	let nextId = 1;

	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) {
				continue;
			}
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				stderrLines.push(`stdout 里有非 JSON 内容（协议违规）：${line.slice(0, 120)}`);
				continue;
			}
			const resolve = pending.get(message.id);
			if (resolve) {
				pending.delete(message.id);
				resolve(message);
			}
		}
	});
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk) => stderrLines.push(String(chunk).trim()));

	return {
		stderrLines,
		request(method, params) {
			const id = nextId++;
			const promise = new Promise((resolve, reject) => {
				pending.set(id, resolve);
				setTimeout(() => {
					if (pending.has(id)) {
						pending.delete(id);
						reject(new Error(`MCP 响应超时：${method}`));
					}
				}, 20000);
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
			return promise;
		},
		notify(method, params) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
		},
		async close() {
			child.stdin.end();
			await new Promise((resolve) => child.once('exit', resolve));
		}
	};
}

/**
 * 跑一次 ocs-watch（--once），返回 stdout。
 *
 * ⚠️ 必须用异步 spawn，不能图省事用 execFileSync：假 OCS 就跑在本进程里，
 * 同步 API 会阻塞父进程的事件循环，子进程连上来却没人应答，最后只能等超时（假死）。
 */
function runWatch(env, stateFile) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [WATCH, '--once', '--state', stateFile], {
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		let err = '';
		child.stdout.on('data', (chunk) => (out += chunk));
		child.stderr.on('data', (chunk) => (err += chunk));
		const timer = setTimeout(() => {
			child.kill();
			resolve(`[进程超时] ${err || out}`);
		}, 30000);
		child.on('exit', () => {
			clearTimeout(timer);
			resolve(out.trim() || `[无输出] ${err.trim()}`);
		});
	});
}

/** 同 runWatch，但把 stdout / stderr / 退出码都带回来（用于投递相关的用例） */
function runWatchDetailed(env, stateFile, extraArgs = []) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [WATCH, '--once', '--state', stateFile, ...extraArgs], {
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		let err = '';
		child.stdout.on('data', (chunk) => (out += chunk));
		child.stderr.on('data', (chunk) => (err += chunk));
		const timer = setTimeout(() => {
			child.kill();
			resolve({ out: out.trim(), err: err.trim(), code: -1 });
		}, 30000);
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolve({ out: out.trim(), err: err.trim(), code });
		});
	});
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-openclaw-test-'));
const { certPath, keyPath } = ensureTestCert(workDir);
const certPem = fs.readFileSync(certPath, 'utf8');
const keyPem = fs.readFileSync(keyPath, 'utf8');
const fingerprint = fingerprintOfPem(certPem);

const mock = await startMockOcs({ certPem, keyPem, apiKey: API_KEY });
const env = {
	OCS_BASE: mock.base,
	OCS_API_KEY: API_KEY,
	OCS_CERT_SHA256: fingerprint
};
console.log(`假 OCS 已启动：${mock.base}（指纹 ${fingerprint.slice(0, 20)}…）\n`);

// ---------- 1. ocs-client ----------
console.log('=== ocs-client ===');
{
	const cfg = loadConfig(env);
	const health = await OcsApi.health(cfg);
	check('health 能连通并解包 data', health.version, '2.13.6-test');
	check('health 回传的指纹与证书一致', health.certFingerprint, fingerprint);

	const logs = await OcsApi.logs(cfg, UID, 50);
	checkMatch('logs 返回脱敏后的文本', logs.text, /账号 \*\*\* 登录失败/);

	const shot = await OcsApi.screenshot(cfg, UID);
	check('screenshot 返回图片类型', shot.mimeType, 'image/png');
	check('screenshot 带回页面标题', shot.pageTitle, '智慧树网');

	// 指纹不匹配必须拒绝
	try {
		await OcsApi.health(loadConfig({ ...env, OCS_CERT_SHA256: 'AA:BB:CC' }));
		check('指纹不匹配时拒绝连接', '没有抛错', '抛错');
	} catch (err) {
		checkMatch('指纹不匹配时拒绝连接', err.message, /指纹不匹配/);
	}

	// 密钥错误要有明确的 code（注意 health 是免鉴权的，得挑一个需要密钥的接口）
	try {
		await OcsApi.browsers(loadConfig({ ...env, OCS_API_KEY: 'wrong-key-0000' }), {});
		check('密钥错误时抛错', '没有抛错', '抛错');
	} catch (err) {
		check('密钥错误时抛错', err.code, 'UNAUTHORIZED');
	}

	// 缺配置要在启动阶段就拦下
	try {
		loadConfig({ OCS_BASE: 'https://127.0.0.1:1' });
		check('缺密钥时拒绝启动', '没有抛错', '抛错');
	} catch (err) {
		checkMatch('缺密钥时拒绝启动', err.message, /缺少 OCS_API_KEY/);
	}
}

// ---------- 2. ocs-mcp-server ----------
console.log('\n=== ocs-mcp-server（stdio 协议）===');
{
	const mcp = startMcp(env);
	const init = await mcp.request('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'test', version: '0' }
	});
	check('initialize 回服务器名', init.result.serverInfo.name, 'ocs-desktop');
	check('initialize 回客户端请求的协议版本', init.result.protocolVersion, '2025-06-18');
	mcp.notify('notifications/initialized', {});

	const list = await mcp.request('tools/list', {});
	const names = (list.result.tools || []).map((t) => t.name);
	check('工具数量', names.length, 12);
	checkMatch('包含 ocs_logs', names.join(','), /ocs_logs/);
	checkMatch('包含 ocs_screenshot', names.join(','), /ocs_screenshot/);

	const health = await mcp.request('tools/call', { name: 'ocs_health', arguments: {} });
	checkMatch('ocs_health 文本', health.result.content[0].text, /渲染进程就绪: 是/);

	const browsers = await mcp.request('tools/call', { name: 'ocs_list_browsers', arguments: {} });
	checkMatch('ocs_list_browsers 列出实例', browsers.result.content[0].text, /未命名浏览器 \(1\)/);
	check('ocs_list_browsers 默认不带脚本名（省上下文）', /智慧树-手机密码登录/.test(browsers.result.content[0].text), false);

	const detailed = await mcp.request('tools/call', {
		name: 'ocs_list_browsers',
		arguments: { detailed: true }
	});
	checkMatch('ocs_list_browsers detailed 时带出自动化程序名', detailed.result.content[0].text, /智慧树-手机密码登录/);

	const logs = await mcp.request('tools/call', { name: 'ocs_logs', arguments: { uid: UID, lines: 50 } });
	checkMatch('ocs_logs 文本含脱敏日志', logs.result.content[0].text, /账号 \*\*\* 登录失败/);

	const shot = await mcp.request('tools/call', { name: 'ocs_screenshot', arguments: { uid: UID } });
	check('ocs_screenshot 回图片内容块', shot.result.content[0].type, 'image');
	checkMatch('ocs_screenshot 附带来源说明', shot.result.content[1].text, /智慧树网/);

	const unknown = await mcp.request('tools/call', { name: 'ocs_not_exist', arguments: {} });
	check('未知工具返回 isError', unknown.result.isError, true);

	await mcp.close();
	check('MCP 子进程没有往 stdout 写脏数据', mcp.stderrLines.filter((l) => l.includes('协议违规')), []);

	// OCS_MCP_TOOLSET=basic 时只注册常用工具（工具定义每轮都会发给模型，少注册就是省 token）
	const basicMcp = startMcp({ ...env, OCS_MCP_TOOLSET: 'basic' });
	await basicMcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
	basicMcp.notify('notifications/initialized', {});
	const basicList = await basicMcp.request('tools/list', {});
	const basicNames = (basicList.result.tools || []).map((t) => t.name);
	check('basic 工具集只有 8 个工具', basicNames.length, 8);
	checkMatch('basic 工具集保留 ocs_logs', basicNames.join(','), /ocs_logs/);
	check('basic 工具集不含 ocs_add_script', /ocs_add_script/.test(basicNames.join(',')), false);
	await basicMcp.close();
}

// ---------- 3. ocs-watch ----------
console.log('\n=== ocs-watch（推送）===');
{
	const stateFile = path.join(workDir, 'watch-state.json');

	const first = await runWatch(env, stateFile);
	check('首轮只做基线，不播报历史日志', first, 'HEARTBEAT_OK');

	mock.appendLog(UID, '智慧树：检测到验证码，需要人工处理\n');
	const second = await runWatch(env, stateFile);
	checkMatch('新日志命中关键字后播报', second, /需要人工处理/);
	checkMatch('播报带浏览器名与短 uid', second, /未命名浏览器 \(1\) \[aaaaaaaa\]/);

	const third = await runWatch(env, stateFile);
	check('同一行不会重复播报', third, 'HEARTBEAT_OK');

	// 同样的文本再次出现（例如每次登录失败都是同一句错误）必须仍然播报，
	// 否则「消息未推送」——旧实现按整行哈希去重会永久吞掉
	mock.appendLog(UID, '智慧树：检测到验证码，需要人工处理\n');
	const repeated = await runWatch(env, stateFile);
	checkMatch('重复出现的同一行仍会播报', repeated, /需要人工处理/);

	mock.setStatus(UID, 'closed');
	const fourth = await runWatch(env, stateFile);
	checkMatch('状态变化会播报', fourth, /状态：launched → closed/);
	const fifth = await runWatch(env, stateFile);
	check('状态变化也做了去重', fifth, 'HEARTBEAT_OK');

	// 连不上：只在状态翻转时提醒一次
	const deadState = path.join(workDir, 'watch-state-dead.json');
	const deadEnv = { ...env, OCS_BASE: 'https://127.0.0.1:1' };
	checkMatch('连不上时提醒', await runWatch(deadEnv, deadState), /连不上 OCS/);
	check('连不上不会每轮刷屏', await runWatch(deadEnv, deadState), 'HEARTBEAT_OK');
}

// ---------- 4. ocs-watch 投递到 DSH ----------
console.log('\n=== ocs-watch（投递到 DSH-IM 主动投递接口）===');
{
	// 假的 DSH 投递接口，收集收到的消息
	const deliveries = [];
	const sink = http.createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			try {
				deliveries.push(JSON.parse(body));
			} catch {
				deliveries.push({ invalid: body });
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{"sent":true}');
		});
	});
	await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
	const sinkUrl = `http://127.0.0.1:${sink.address().port}/api/dsh-im/delivery/messages`;

	const deliverArgs = [
		'--deliver',
		'dsh',
		'--dsh-url',
		sinkUrl,
		'--bot-id',
		'bot_test123',
		'--target-id',
		'tgt_alerts'
	];
	const stateFile = path.join(workDir, 'watch-dsh-state.json');

	// 前面的用例把浏览器关掉了；看门狗只扫「运行中」的浏览器日志，这里先恢复回运行状态
	mock.setStatus(UID, 'launched');

	const first = await runWatchDetailed(env, stateFile, deliverArgs);
	check('首轮基线不投递', deliveries.length, 0);
	check('dsh 模式下 stdout 保持干净（不打 HEARTBEAT_OK）', first.out, '');

	mock.appendLog(UID, '智慧树：登录成功\n');
	const second = await runWatchDetailed(env, stateFile, deliverArgs);
	check('有新内容时投递一条', deliveries.length, 1);
	const delivered = deliveries[0] || {};
	check('投递带上 botId', delivered.botId, 'bot_test123');
	check('投递带上 targetId', delivered.targetId, 'tgt_alerts');
	checkMatch('投递正文包含通知内容', delivered.text, /智慧树：登录成功/);
	check('投递正文不是 HEARTBEAT_OK', delivered.text === 'HEARTBEAT_OK', false);
	check('投递后 stdout 仍为空', second.out, '');

	await runWatchDetailed(env, stateFile, deliverArgs);
	check('同一行不会重复投递', deliveries.length, 1);

	// 投递失败不能把看门狗弄死：先跑一轮做基线，再造一条新日志，然后投递到死地址
	const deadArgs = ['--deliver', 'dsh', '--dsh-url', 'http://127.0.0.1:1/x', '--bot-id', 'b', '--target-id', 't'];
	const deadState = path.join(workDir, 'watch-dsh-state2.json');
	await runWatchDetailed(env, deadState, deadArgs);
	mock.appendLog(UID, '智慧树：密码错误\n');
	const deadSink = await runWatchDetailed(env, deadState, deadArgs);
	check('投递失败时进程正常退出', deadSink.code, 0);
	checkMatch('投递失败有 stderr 提示', deadSink.err, /投递失败/);

	// 缺 botId/targetId 要在启动时就拒绝
	const missing = await runWatchDetailed(env, path.join(workDir, 'watch-dsh-state3.json'), ['--deliver', 'dsh']);
	check('缺投递参数时以退出码 2 拒绝', missing.code, 2);
	checkMatch('缺参数给出明确提示', missing.err, /DSH_BOT_ID/);

	sink.close();
}

await mock.close();
console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
console.log(`（测试产物目录：${workDir}）`);
process.exit(fail === 0 ? 0 : 1);
