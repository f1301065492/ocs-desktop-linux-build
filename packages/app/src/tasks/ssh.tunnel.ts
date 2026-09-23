import { spawn, execFile, ChildProcess } from 'child_process';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import defaultsDeep from 'lodash/defaultsDeep';
import { store, OriginalAppStore } from '../store';
import { Logger } from '../logger';

const logger = Logger('ssh-tunnel');

/**
 * SSH 反向隧道管理。
 *
 * 解决的问题：OCS 跑在没有公网 IP 的内网，而调用方在公网 VPS 上。
 * 由 OCS 主动往外连，把本机的远程 API 端口映射到 VPS 的回环地址上。
 *
 * 全流程只用 OpenSSH 原生工具（ssh / ssh-keygen / ssh-keyscan），
 * 不走 Node 的 crypto——后者只能导出 PKCS#8 PEM，而 OpenSSH 的原生格式是
 * `-----BEGIN OPENSSH PRIVATE KEY-----`，没必要冒格式兼容的风险。
 *
 * 密钥与 known_hosts 都放应用数据目录，不碰用户的 ~/.ssh。
 */

export type SshTunnelState =
	| 'disabled'
	/** 配置不完整（缺主机/用户名，或还没生成密钥） */
	| 'incomplete'
	/** 已启用但主机指纹还没确认过 */
	| 'need_host_key'
	/** ssh 已拉起，尚未确认是否稳定 */
	| 'connecting'
	| 'running'
	/** ssh 退出或启动失败 */
	| 'failed';

export type SshTunnelConfig = typeof OriginalAppStore.sshTunnel;

let child: ChildProcess | null = null;
let state: SshTunnelState = 'disabled';
let lastError: string | null = null;
let stderrTail: string[] = [];
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartAttempt = 0;
/** 主动停止时置位，用于区分「我们要它停」和「它自己挂了」 */
let stopping = false;
let startedAt = 0;

/** 重连退避：一直失败时最长 30 秒试一次，避免打成忙循环 */
const RESTART_BACKOFF = [1000, 2000, 5000, 15000, 30000];
/** 连续存活超过这个时长就把退避重置，避免「跑了很久后偶发一次断线」还要等 30 秒 */
const HEALTHY_UPTIME_MS = 60 * 1000;

function dir(): string {
	return path.join(app.getPath('userData'), 'ssh-tunnel');
}

function knownHostsPath(): string {
	return path.join(dir(), 'known_hosts');
}

function defaultKeyPath(): string {
	return path.join(dir(), 'id_ed25519');
}

/**
 * 防御性读取配置。
 *
 * initStore() 只在版本号升高时才用 defaultsDeep 补齐缺失键，
 * 同版本重启（例如开发构建）不会补，所以绝不能假设字段完整。
 */
export function getSshTunnelConfig(): SshTunnelConfig {
	return defaultsDeep({}, store.store.sshTunnel ?? {}, OriginalAppStore.sshTunnel) as SshTunnelConfig;
}

export function updateSshTunnelConfig(patch: Partial<SshTunnelConfig>): SshTunnelConfig {
	const next = { ...getSshTunnelConfig(), ...patch };
	store.set('sshTunnel', next);
	return next;
}

function resolveKeyPath(config: SshTunnelConfig): string {
	return config.keyPath && config.keyPath.trim() ? config.keyPath.trim() : defaultKeyPath();
}

/** 把子进程输出整理成可读的一行，供设置页展示 */
function summarize(chunk: Buffer | string): string {
	return String(chunk).trim();
}

/**
 * 这个错误会不会因为重试而自愈。
 *
 * 认证失败、主机密钥不符、主机名解析不了——这些都是配置问题，
 * 重试一百次结果一样。而网络抖动、远端端口临时被占属于可自愈的。
 */
function isPermanentFailure(raw: string): boolean {
	return (
		/Permission denied/i.test(raw) ||
		/Host key verification failed/i.test(raw) ||
		/Could not resolve hostname/i.test(raw) ||
		/Too many authentication failures/i.test(raw) ||
		/no such identity|Load key/i.test(raw)
	);
}

/**
 * 把 ssh 的原始报错翻译成可操作的提示。
 *
 * ssh 的输出对使用者不友好，而且容易误读。这里把最常见的几种失败模式
 * 识别出来，直接给出去哪改、改什么。原始输出仍附在末尾供懂行的人排查。
 */
function explainError(raw: string): string {
	const hint = (text: string) => `${text}\n\n原始错误：${raw}`;

	if (/Permission denied \(publickey/.test(raw)) {
		return hint(
			'公钥被拒绝。请确认：\n' +
				'1. 本机公钥已追加进 VPS 的 ~/.ssh/authorized_keys\n' +
				'2. 该文件权限为 600、~/.ssh 目录权限为 700\n' +
				'3. 追加时没有换行错位（公钥必须是一整行）'
		);
	}
	/**
	 * 括号里**没有** publickey 时的通用提示。
	 *
	 * 注意别把这里断言成「服务端禁用了公钥认证」——括号里列的是本次连接
	 * 实际尝试过的方式，不是服务端支持的方式。本机没有可提供的密钥时也会
	 * 只报 password，但服务端其实是支持公钥的。这里只列可能原因，不下结论。
	 */
	if (/Permission denied/.test(raw)) {
		return hint(
			'认证失败。可能的原因：\n' +
				'1. 公钥尚未写入 VPS 的 ~/.ssh/authorized_keys\n' +
				'2. 私钥文件不可读或已损坏\n' +
				'3. VPS 的 /etc/ssh/sshd_config 里 PubkeyAuthentication 被显式设成了 no（默认是 yes）'
		);
	}
	if (/Host key verification failed/.test(raw)) {
		return hint('主机指纹与已记录的不一致。如果 VPS 重装过或换过密钥，请重新获取并确认指纹。');
	}
	if (/Connection refused/i.test(raw)) {
		return hint('连接被拒绝。通常是 SSH 端口填错了（很多服务器不是 22），或 sshd 没在运行。');
	}
	if (/Connection timed out|No route to host|Network is unreachable/i.test(raw)) {
		return hint('网络不通。检查地址是否正确、VPS 防火墙与安全组是否放行了该端口。');
	}
	if (/Could not resolve hostname/i.test(raw)) {
		return hint('主机名解析失败，请检查地址是否拼写正确。');
	}
	if (/remote port forwarding failed|Administratively prohibited/i.test(raw)) {
		return hint(
			'远端端口转发被拒绝。可能 VPS 上该端口已被占用（上一次连接没退干净），\n' +
				'或 sshd 配置了 GatewayPorts/PermitListen 限制。'
		);
	}
	if (/Too many authentication failures/i.test(raw)) {
		return hint('认证尝试次数过多。请确认 VPS 上没有其他密钥干扰（本软件已设置 IdentitiesOnly）。');
	}

	return raw;
}

/** 跑一个外部命令并收集输出。带超时，避免 ssh-keyscan 这类命令把流程挂死 */
function run(
	cmd: string,
	args: string[],
	timeoutMs = 15000
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
			// 用 as 取 code 而不是 NodeJS.ErrnoException——项目的 eslint 配置不含 Node 全局，
			// 直接引用 NodeJS 命名空间会报 no-undef
			const code = (err as { code?: string | number } | null)?.code;
			if (err && code === 'ENOENT') {
				reject(new Error(`找不到命令 ${cmd}，请确认已安装 OpenSSH 客户端，或在设置里指定 ssh 路径`));
				return;
			}
			// 非零退出码不算异常——很多命令用退出码表达业务结果，交给调用方判断
			resolve({
				stdout: String(stdout ?? ''),
				stderr: String(stderr ?? ''),
				code: err ? (typeof code === 'number' ? code : 1) : 0
			});
		});
	});
}

// ── 密钥 ──

export interface KeyPairInfo {
	keyPath: string;
	publicKey: string;
	created: boolean;
}

/**
 * 确保密钥存在。没有就生成一对 ed25519。
 * @param force 重新生成（会覆盖旧密钥，调用方需要确认）
 */
export async function ensureKeyPair(force = false): Promise<KeyPairInfo> {
	const config = getSshTunnelConfig();
	const keyPath = resolveKeyPath(config);
	const pubPath = `${keyPath}.pub`;

	fs.mkdirSync(path.dirname(keyPath), { recursive: true });

	if (force) {
		// ssh-keygen 遇到已存在的文件会交互式询问是否覆盖，先删掉避免它卡住
		for (const file of [keyPath, pubPath]) {
			if (fs.existsSync(file)) fs.rmSync(file, { force: true });
		}
	}

	if (!fs.existsSync(keyPath) || !fs.existsSync(pubPath)) {
		const { stderr, code } = await run('ssh-keygen', [
			'-t',
			'ed25519',
			'-f',
			keyPath,
			'-N',
			'', // 空密码短语：无人值守场景没法输入
			'-C',
			'ocs-desktop'
		]);
		if (code !== 0) {
			throw new Error(`生成密钥失败：${stderr || `退出码 ${code}`}`);
		}
		// 私钥只给当前用户可读
		try {
			fs.chmodSync(keyPath, 0o600);
		} catch {
			// Windows 上 chmod 基本无效，忽略
		}
		logger.info(`已生成 SSH 密钥: ${keyPath}`);
		return { keyPath, publicKey: fs.readFileSync(pubPath, 'utf8').trim(), created: true };
	}

	return { keyPath, publicKey: fs.readFileSync(pubPath, 'utf8').trim(), created: false };
}

/** 读取公钥内容（不生成）。没生成过则返回 null */
export function readPublicKey(): string | null {
	const pubPath = `${resolveKeyPath(getSshTunnelConfig())}.pub`;
	return fs.existsSync(pubPath) ? fs.readFileSync(pubPath, 'utf8').trim() : null;
}

// ── 主机密钥 ──

export interface HostKeyInfo {
	fingerprint: string;
	hostKey: string;
}

/**
 * 扫描目标主机的公钥并算出指纹，供用户确认。
 *
 * 用 ssh-keyscan 而不是直接连——前者只取主机密钥，不做认证。
 */
export async function scanHostKey(): Promise<HostKeyInfo> {
	const config = getSshTunnelConfig();
	if (!config.host) {
		throw new Error('请先填写主机地址');
	}

	const { stdout, stderr, code } = await run('ssh-keyscan', ['-p', String(config.port), config.host], 15000);
	const hostKey = stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'))
		.join('\n');

	if (!hostKey) {
		throw new Error(`无法获取主机密钥：${stderr.trim() || '目标无响应'}（检查地址与 SSH 端口是否正确）`);
	}
	if (code !== 0 && !hostKey) {
		throw new Error(`获取主机密钥失败：${stderr.trim() || `退出码 ${code}`}`);
	}

	// ssh-keygen -lf 能直接吃 known_hosts 格式的文本
	fs.mkdirSync(dir(), { recursive: true });
	const tmp = path.join(dir(), '_scanned_host_key');
	fs.writeFileSync(tmp, hostKey + '\n');
	try {
		const result = await run('ssh-keygen', ['-lf', tmp], 10000);
		if (result.code !== 0) {
			throw new Error(`计算主机指纹失败：${result.stderr.trim()}`);
		}
		// 输出形如：256 SHA256:xxxx... host (ED25519)，可能有多行（多种算法）
		const fingerprint = result.stdout
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => line.split(/\s+/).slice(1, 3).join(' '))
			.join(' / ');

		return { fingerprint, hostKey };
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/** 用户确认指纹后，把它写入自带的 known_hosts */
export async function confirmHostKey(): Promise<void> {
	const { fingerprint, hostKey } = await scanHostKey();

	fs.mkdirSync(dir(), { recursive: true });
	fs.writeFileSync(knownHostsPath(), hostKey + '\n', { mode: 0o644 });
	updateSshTunnelConfig({ confirmedFingerprint: fingerprint });
	logger.info(`已确认主机指纹: ${fingerprint}`);

	await restartTunnel();
}

// ── 隧道进程 ──

function buildArgs(config: SshTunnelConfig, keyPath: string, apiPort: number): string[] {
	return [
		'-N', // 不执行远程命令，只做转发
		'-p',
		String(config.port),
		'-i',
		keyPath,
		// 失败就退出，绝不弹交互提示——无人值守下弹提示等于静默挂死
		'-o',
		'BatchMode=yes',
		// 只用我们指定的这把钥匙，不受用户 ~/.ssh/config 干扰
		'-o',
		'IdentitiesOnly=yes',
		'-o',
		'StrictHostKeyChecking=yes',
		'-o',
		`UserKnownHostsFile=${knownHostsPath()}`,
		// 转发建不起来时必须退出，否则会出现"进程活着但隧道不通"这种最难查的状态
		'-o',
		'ExitOnForwardFailure=yes',
		'-o',
		'ServerAliveInterval=30',
		'-o',
		'ServerAliveCountMax=3',
		// 远端绑回环：只有 VPS 本机进程能访问，公网碰不到，也不用改 sshd 的 GatewayPorts
		'-R',
		`${apiPort}:127.0.0.1:${apiPort}`,
		`${config.user}@${config.host}`
	];
}

function spawnTunnel(): void {
	const config = getSshTunnelConfig();
	const apiPort = store.store.remoteApi?.port ?? 15320;
	const keyPath = resolveKeyPath(config);
	const sshCmd = config.sshPath && config.sshPath.trim() ? config.sshPath.trim() : 'ssh';

	stderrTail = [];
	stopping = false;
	state = 'connecting';

	const proc = spawn(sshCmd, buildArgs(config, keyPath, apiPort), { windowsHide: true });
	child = proc;

	proc.stdout?.on('data', (data) => logger.debug(`ssh: ${summarize(data)}`));
	proc.stderr?.on('data', (data) => {
		const text = summarize(data);
		logger.debug(`ssh(stderr): ${text}`);
		// 只留最近几行，避免长期运行把内存撑起来
		stderrTail.push(text);
		if (stderrTail.length > 20) stderrTail.shift();
	});

	proc.on('error', (err) => {
		// spawn 本身失败（命令不存在、无执行权限等）
		state = 'failed';
		lastError = err.message.includes('ENOENT')
			? `找不到 ssh 命令（${sshCmd}），请确认已安装 OpenSSH 客户端，或在设置里指定 ssh 路径`
			: err.message;
		logger.error(`隧道启动失败: ${lastError}`);
		child = null;
	});

	proc.on('exit', (code, signal) => {
		if (child === proc) child = null;

		if (stopping) {
			state = 'disabled';
			startedAt = 0;
			logger.info('隧道已停止');
			return;
		}

		// 连上后 ssh 不会自动退出，所以走到这里基本都意味着出了问题
		const uptime = startedAt ? Date.now() - startedAt : 0;
		if (uptime > HEALTHY_UPTIME_MS) {
			restartAttempt = 0;
		}

		state = 'failed';
		const raw = stderrTail.length ? stderrTail.join('\n') : `ssh 退出（code=${code} signal=${signal}）`;
		lastError = explainError(raw);

		/**
		 * 认证失败、主机密钥不符这类问题不会因为重试而自愈，
		 * 一直按退避重连只会在 VPS 上刷失败日志。改成停下来等用户处理，
		 * 修好后点「重新连接」即可。
		 */
		if (isPermanentFailure(raw)) {
			logger.warn(`隧道因不可自愈的错误停止，等待人工处理: ${raw.split('\n')[0]}`);
			return;
		}

		logger.warn(`隧道断开（存活 ${Math.round(uptime / 1000)}s），${Math.round(nextDelay() / 1000)}s 后重连`);
		scheduleRestart();
	});

	startedAt = Date.now();
	// spawn 是异步的，这里先乐观置为 running；真正失败会由 error/exit 改成 failed
	state = 'running';
	lastError = null;
	logger.info(`隧道已启动 => ${config.user}@${config.host}:${config.port}，映射远端 127.0.0.1:${apiPort}`);
}

function nextDelay(): number {
	const delay = RESTART_BACKOFF[Math.min(restartAttempt, RESTART_BACKOFF.length - 1)];
	restartAttempt++;
	return delay;
}

function scheduleRestart(): void {
	if (restartTimer) return;
	restartTimer = setTimeout(() => {
		restartTimer = null;
		// 重连前重新判断一次：期间用户可能已经禁用了隧道
		if (!getSshTunnelConfig().enabled) {
			state = 'disabled';
			return;
		}
		spawnTunnel();
	}, nextDelay());
}

/** 启动隧道。配置不全或指纹未确认时只更新状态，不报错 */
export async function startTunnel(): Promise<void> {
	const config = getSshTunnelConfig();

	if (!config.enabled) {
		state = 'disabled';
		lastError = null;
		return;
	}
	if (!config.host || !config.user) {
		state = 'incomplete';
		lastError = '请填写主机地址和用户名';
		return;
	}
	if (!fs.existsSync(resolveKeyPath(config))) {
		state = 'incomplete';
		lastError = '尚未生成密钥';
		return;
	}
	if (!config.confirmedFingerprint) {
		// 首次连接必须先让用户确认主机指纹
		state = 'need_host_key';
		lastError = null;
		return;
	}

	try {
		restartAttempt = 0;
		spawnTunnel();
	} catch (err) {
		state = 'failed';
		lastError = err instanceof Error ? err.message : String(err);
		logger.error(`隧道启动异常: ${lastError}`);
	}
}

/**
 * 停止隧道。**同步**实现——因为要在 process.on('exit') 里调用，
 * 那个钩子里不允许有异步操作。
 */
export function stopTunnel(): void {
	stopping = true;
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	if (child) {
		try {
			child.kill();
		} catch {
			// 进程可能已经没了
		}
		child = null;
	}
	state = 'disabled';
	startedAt = 0;
}

/** 重启（配置变更、指纹确认后调用） */
export async function restartTunnel(): Promise<void> {
	stopTunnel();
	// 等旧进程真正退干净，避免远端端口被上一次连接占着导致 ExitOnForwardFailure
	await new Promise((resolve) => setTimeout(resolve, 300));
	restartAttempt = 0;
	await startTunnel();
}

export interface SshTunnelStatus {
	config: SshTunnelConfig;
	state: SshTunnelState;
	/** 状态的中文说明，设置页直接用 */
	stateText: string;
	lastError: string | null;
	/** 已生成的公钥，供设置页展示与复制 */
	publicKey: string | null;
	keyPath: string;
	/** 隧道映射的远端端口 */
	remotePort: number;
	uptimeMs: number;
}

const STATE_TEXT: Record<SshTunnelState, string> = {
	disabled: '已停止',
	incomplete: '配置不完整',
	need_host_key: '等待确认主机指纹',
	connecting: '连接中',
	running: '运行中',
	failed: '连接失败'
};

/** 只回传可展示信息，密钥内容以外不暴露任何路径以外的细节 */
export function getSshTunnelStatus(): SshTunnelStatus {
	return {
		config: getSshTunnelConfig(),
		state,
		stateText: STATE_TEXT[state],
		lastError,
		publicKey: readPublicKey(),
		keyPath: resolveKeyPath(getSshTunnelConfig()),
		remotePort: store.store.remoteApi?.port ?? 15320,
		uptimeMs: state === 'running' && startedAt ? Date.now() - startedAt : 0
	};
}
