/**
 * 连接自检：在装 DSH 的那台机器上先跑这个，确认「OCS 可达 + 密钥对 + 证书指纹对」，
 * 再去配 DSH 的 MCP。这样出问题时能一眼分清是网络/凭据问题，还是 DSH 配置问题。
 *
 * 用法：
 *   node check-ocs.mjs                     # 只看连通性 + 浏览器列表
 *   node check-ocs.mjs --uid <uid>          # 顺带看这个浏览器的状态和最近日志
 *   node check-ocs.mjs --uid <uid> --lines 50
 *
 * 环境变量：OCS_BASE / OCS_API_KEY / OCS_CERT_SHA256（建议）/ OCS_TLS_STRICT / OCS_TIMEOUT_MS
 * 退出码：0 全部正常；1 有失败项。
 */
import { loadConfig, OcsApi, request } from './ocs-client.mjs';

function parseArgs(argv) {
	const args = { uid: '', lines: 20 };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--uid') args.uid = String(argv[++i] || '');
		else if (argv[i] === '--lines') args.lines = Math.min(200, Math.max(1, Number(argv[++i]) || 20));
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
let failures = 0;
function ok(name, detail) {
	console.log(`  ✓ ${name}${detail ? `：${detail}` : ''}`);
}
function fail(name, detail) {
	failures++;
	console.log(`  ✗ ${name}${detail ? `：${detail}` : ''}`);
}
function normalize(value) {
	return String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

console.log('=== 配置 ===');
let cfg;
try {
	cfg = loadConfig();
} catch (err) {
	// 只差密钥时仍然值得先测连通性：/health 免鉴权，能立刻回答「地址对不对、OCS 起没起」
	const base = (process.env.OCS_BASE || '').trim().replace(/\/+$/, '');
	if (/OCS_API_KEY/.test(err.message) && /^https:\/\//i.test(base)) {
		cfg = {
			base,
			apiKey: '',
			fingerprint: (process.env.OCS_CERT_SHA256 || '').trim(),
			strict: process.env.OCS_TLS_STRICT === '1',
			timeoutMs: 8000
		};
		console.log('  OCS_API_KEY 未配置 → 先只测连通性（带密钥的检查会跳过）');
	} else {
		fail('配置不完整', err.message);
		process.exit(1);
	}
}
// 密钥只显示首尾，避免整串进日志/截图
console.log(`  OCS_BASE        = ${cfg.base}`);
console.log(
	cfg.apiKey ? `  OCS_API_KEY     = ${cfg.apiKey.slice(0, 4)}…${cfg.apiKey.slice(-4)}（长度 ${cfg.apiKey.length}）` : '  OCS_API_KEY     = (未配置)'
);
console.log(`  OCS_CERT_SHA256 = ${cfg.fingerprint || '(未配置，将不校验自签证书)'}`);

console.log('\n=== 1. 健康检查（不需要密钥也能通） ===');
let health;
try {
	// health 免鉴权，用最原始的方式先确认网络可达；超时压到 8 秒，地址填错时不用干等两分钟
	const res = await request(cfg, 'GET', '/api/v1/health', { timeoutMs: 8000 });
	const body = JSON.parse(res.text);
	if (res.status !== 200 || !body.data) {
		fail('健康检查返回异常', `HTTP ${res.status}`);
	} else {
		health = body.data;
		ok('OCS 可达', `${cfg.base} → HTTP ${res.status}`);
		console.log(`     版本 ${health.version}｜远程 API 监听 ${health.listening ? '是' : '否'}｜渲染进程就绪 ${health.rendererReady ? '是' : '否'}`);
		console.log(`     证书指纹 ${health.certFingerprint}`);
		console.log(`     可用地址 ${(health.addresses || []).join(', ') || '(无)'}`);
		if (!health.listening) {
			fail('远程 API 未在监听', '去 OCS 设置 → 远程 API 里确认已开启');
		} else {
			ok('远程 API 已监听');
		}
		if (!health.rendererReady) {
			fail('渲染进程未就绪', '软件刚启动时会有几秒这个状态；持续这样说明主窗口没起来');
		} else {
			ok('渲染进程就绪');
		}
		if (cfg.fingerprint) {
			if (normalize(cfg.fingerprint) === normalize(health.certFingerprint)) {
				ok('配置里的证书指纹与服务端一致');
			} else {
				fail('证书指纹不一致', `配置 ${cfg.fingerprint} ≠ 服务端 ${health.certFingerprint}（OCS 重装或换 IP 后会重新生成）`);
			}
		}
	}
} catch (err) {
	const message = err && err.message ? err.message : String(err);
	if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|时间超时|请求超时/.test(message)) {
		fail('连不上 OCS', `${message}\n      → 检查：机器 A 的 IP/端口、防火墙是否放行 TCP 15320、两台机器是否同一网段`);
	} else if (/指纹不匹配/.test(message)) {
		fail(
			'证书指纹不匹配',
			`${message}\n      → OCS 重装/换 IP 后会重新生成自签证书：去 https://<ip>:15320/api/v1/health 取新的 certFingerprint 更新 OCS_CERT_SHA256`
		);
	} else if (/self.signed|self signed|证书|CERT/.test(message)) {
		fail('TLS 校验失败', `${message}\n      → 自签证书请配置 OCS_CERT_SHA256；若故意不校验，别设 OCS_TLS_STRICT=1`);
	} else {
		fail('健康检查失败', message);
	}
}

if (failures === 0 && !cfg.apiKey) {
	console.log('\n=== 2. 带密钥调用（浏览器列表）===');
	console.log('  （OCS_API_KEY 未配置，跳过；把密钥填上再跑一次即可）');
}

if (failures === 0 && cfg.apiKey) {
	console.log('\n=== 2. 带密钥调用（浏览器列表） ===');
	try {
		const data = await OcsApi.browsers(cfg, {});
		const list = (data && data.browsers) || [];
		ok('密钥有效', `共 ${list.length} 个浏览器`);
		for (const item of list) {
			console.log(`     - ${item.name ?? '(未命名)'}  [${String(item.uid).slice(0, 8)}]  ${item.status ?? '?'}`);
		}
		if (list.length === 0) {
			console.log('     （列表为空：OCS 里还没有创建浏览器）');
		}
	} catch (err) {
		const code = err && err.code;
		const message = err && err.message ? err.message : String(err);
		if (code === 'UNAUTHORIZED') {
			fail('密钥无效', '去 OCS 设置 → 远程 API 重新生成一次（明文只显示一次）');
		} else if (code === 'NOT_ENABLED') {
			fail('远程 API 未开启', '去 OCS 设置 → 远程 API 打开开关');
		} else if (code === 'RENDERER_UNAVAILABLE') {
			fail('渲染进程不可用', '稍等几秒重试；持续如此请重启 OCS 客户端');
		} else {
			fail('调用失败', message);
		}
	}
}

if (args.uid && failures === 0 && cfg.apiKey) {
	console.log(`\n=== 3. 浏览器 ${args.uid.slice(0, 8)} 的详情与日志 ===`);
	try {
		const browser = await OcsApi.browser(cfg, args.uid);
		ok('浏览器存在', `${browser.name}｜状态 ${browser.status}`);
		const logs = await OcsApi.logs(cfg, args.uid, args.lines);
		ok('日志接口可用', `状态=${logs.status} 行数=${logs.lineCount} 脱敏替换=${logs.masked}`);
		const text = (logs.text || '').trim();
		if (text) {
			console.log('     ---- 最近日志（已脱敏）----');
			for (const line of text.split('\n').slice(-args.lines)) {
				console.log(`     ${line}`);
			}
		} else {
			console.log('     （日志为空：浏览器没在跑时读不到历史日志）');
		}
	} catch (err) {
		fail('读取浏览器/日志失败', err && err.message ? err.message : String(err));
	}
}

console.log(
	failures === 0
		? cfg.apiKey
			? '\n结论：OCS 这一侧已就绪 ✅ 可以按 README 的「DSH 接入」把 MCP 挂上去了'
			: '\n结论：网络与证书通了 ✅ 但还没配密钥（OCS_API_KEY），带密钥的检查已跳过；填上密钥再跑一次'
		: `\n结论：有 ${failures} 项没过 ❌ 先把上面 ✗ 的问题解决，再去配 DSH`
);
process.exit(failures === 0 ? 0 : 1);
