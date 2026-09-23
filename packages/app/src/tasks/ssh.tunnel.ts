import { spawn, execFile, ChildProcess } from 'child_process';
import { app } from 'electron';
import crypto from 'crypto';
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
		/no such identity|Load key/i.test(raw) ||
		/contents do not match public/i.test(raw)
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

	/**
	 * 这一条必须排在最前面判断。
	 *
	 * 它的原始输出里**同时**包含 `Permission denied (publickey...)`——那是它导致的后果，
	 * 而不是原因。若按下面的顺序落到「公钥被拒绝」那一支，用户会去 VPS 上反复检查
	 * authorized_keys，而真正的问题在本机的两个密钥文件之间。
	 */
	if (/contents do not match public/i.test(raw)) {
		return hint(
			'本机的私钥与公钥文件不是同一把钥匙，ssh 因此拒绝用它认证。\n' +
				'软件会在每次连接前按私钥自动重写公钥文件；请点「重新连接」，\n' +
				'然后把设置页显示的「本机公钥」重新追加到 VPS 的 authorized_keys（旧的那行可以删掉）。'
		);
	}
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
	/**
	 * 「本机没有这个主机的记录」和「记录与实测不一致」要分开说。
	 *
	 * 前者是还没确认过指纹（或 known_hosts 没被读到），后者才是 VPS 换了密钥。
	 * 混成一句话会让用户对着本就没问题的指纹反复重新确认。
	 */
	if (/No .* host key is known/i.test(raw)) {
		return hint(
			'本机没有该主机的密钥记录。请在设置页点「获取主机指纹」，与 VPS 上 ssh-keygen -lf 的结果核对一致后，再点「确认并连接」。'
		);
	}
	if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(raw)) {
		return hint('主机密钥与已记录的不一致。如果 VPS 重装过或换过密钥，请重新获取并确认指纹。');
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
	/** 公钥文件与私钥不是同一把钥匙，已被按私钥重写 */
	repaired: boolean;
	/** 公钥指纹（`SHA256:...`），可与 VPS 上 `ssh-keygen -lf ~/.ssh/authorized_keys` 对照 */
	fingerprint: string | null;
}

/** 密钥文件有问题时的说明，设置页直接展示；一切正常时为 null */
let keyIssue: string | null = null;

/** 公钥行的「类型 + 密钥体」，比对时忽略尾部注释（注释可以随便改，不参与等价判断） */
function keyMaterial(publicKey: string): string {
	return publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
}

/**
 * 公钥指纹，算法与 `ssh-keygen -lf` 完全一致：
 * 对 base64 解码后的密钥体做 SHA256，再 base64（去掉 `=` 填充）并加上 `SHA256:` 前缀。
 *
 * 自己算而不是调 ssh-keygen，是为了让同步的状态查询也能带上指纹。
 */
export function keyFingerprint(publicKey: string | null): string | null {
	if (!publicKey) return null;
	const parts = publicKey.trim().split(/\s+/);
	if (parts.length < 2) return null;
	try {
		const digest = crypto.createHash('sha256').update(Buffer.from(parts[1], 'base64')).digest('base64');
		return `SHA256:${digest.replace(/=+$/, '')}`;
	} catch {
		return null;
	}
}

/**
 * 从私钥推导公钥（不含注释）。
 *
 * `-P ''` 必须带：私钥若设了密码短语，不带它 ssh-keygen 会去交互要密码，
 * 而无人值守场景没有输入源，只会把流程挂到超时。
 */
async function derivePublicKey(keyPath: string): Promise<string> {
	const { stdout, stderr, code } = await run('ssh-keygen', ['-y', '-P', '', '-f', keyPath], 8000);
	const derived = stdout.trim();
	if (code !== 0 || !derived) {
		throw new Error(stderr.trim() || `退出码 ${code}`);
	}
	return derived;
}

/**
 * 校验「私钥 ↔ 公钥」是否配对，不配对就**按私钥重写公钥文件**。
 *
 * 为什么必须做：ssh 用 `-i` 指向私钥时，会优先读取**同名的 `.pub`**、把这个公钥
 * 报给服务器；服务器认可之后，才用私钥签名。两者不是同一把钥匙时 ssh 直接拒绝：
 *
 *     identity_sign: private key /path/id_ed25519 contents do not match public
 *
 * 这条报错看不出该改哪里，而真实原因可能只是某一刻 `.pub` 与私钥被分别写坏了
 * （例如两把钥匙的文件混在了一起）。以私钥为准重写公钥即可恢复——私钥是唯一的，
 * 丢了就等于换了把钥匙；公钥只是它的派生物，随时可以重算。
 *
 * @returns 是否发生了重写
 */
async function verifyKeyPair(keyPath: string): Promise<boolean> {
	const pubPath = `${keyPath}.pub`;
	let derived: string;
	try {
		derived = await derivePublicKey(keyPath);
	} catch (err) {
		// 私钥读不出来：损坏，或者设了密码短语要靠 agent 提供。
		// 这里**不阻断**连接——ssh 自己还有 agent / askpass 的路子能走通，
		// 只把问题摆到设置页上让人知道。
		keyIssue = `私钥无法读取：${
			err instanceof Error ? err.message : String(err)
		}。若这把私钥设了密码短语，无人值守下没法输入，请改用软件生成的密钥。`;
		return false;
	}

	const current = fs.existsSync(pubPath) ? fs.readFileSync(pubPath, 'utf8').trim() : '';
	if (current && keyMaterial(current) === keyMaterial(derived)) {
		keyIssue = null;
		return false;
	}

	/**
	 * 注释（公钥行最后那段）的取舍：优先沿用私钥里带的那个，
	 * 其次沿用原公钥文件里的，都没有才用默认值。
	 *
	 * 有些 OpenSSH 版本的 `ssh-keygen -y` 会把注释一起打出来（实测 Windows 版会），
	 * 直接拼字符串就会得到 `... ocs-desktop ocs-desktop`。
	 */
	const derivedParts = derived.split(/\s+/);
	const comment = derivedParts[2] || current.split(/\s+/)[2] || 'ocs-desktop';
	fs.writeFileSync(pubPath, `${derivedParts[0]} ${derivedParts[1]} ${comment}\n`, { mode: 0o644 });
	keyIssue = current
		? '公钥文件与私钥不是同一把钥匙。已按私钥重算并覆盖公钥文件——VPS 的 authorized_keys 里装的很可能正是被覆盖的那个旧公钥，请把下面显示的「本机公钥」重新追加一次。'
		: '公钥文件缺失，已按私钥重新生成。请确认 VPS 的 authorized_keys 里装的就是下面这行公钥。';
	// 两个指纹都记进日志：这是「哪把钥匙在哪」这类问题唯一的线索
	logger.warn(
		`公钥文件与私钥不一致，已按私钥重写: ${pubPath}（旧公钥 ${keyFingerprint(current) ?? '无法解析'} → 新公钥 ${
			keyFingerprint(derived) ?? '无法解析'
		}）`
	);
	return true;
}

function readPublicKeyFile(pubPath: string): string {
	try {
		return fs.readFileSync(pubPath, 'utf8').trim();
	} catch {
		return '';
	}
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

	let created = false;
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
		created = true;
	}

	// 生成完也要校验一遍：ssh-keygen 若只写坏了其中一半（磁盘满、被中断），
	// 下一次连接就会以那句看不懂的 mismatch 报错收场
	const repaired = await verifyKeyPair(keyPath);
	const publicKey = readPublicKeyFile(pubPath);

	return { keyPath, publicKey, created, repaired, fingerprint: keyFingerprint(publicKey) };
}

/**
 * 读取状态前先做一次密钥配对校验。
 *
 * 设置页每次刷新状态都会走到这里，于是「公钥文件是坏的」这件事会在用户**复制公钥之前**
 * 就被发现并修好——否则用户复制的正是那个坏掉的公钥，装到 VPS 上又是一轮排查。
 */
export async function ensureKeyHealthy(): Promise<void> {
	const keyPath = resolveKeyPath(getSshTunnelConfig());
	if (!fs.existsSync(keyPath)) {
		keyIssue = null;
		return;
	}
	await verifyKeyPair(keyPath);
}

/** 读取公钥内容（不生成）。没生成过则返回 null */
export function readPublicKey(): string | null {
	return readPublicKeyFile(`${resolveKeyPath(getSshTunnelConfig())}.pub`) || null;
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
		// 路径必须加双引号：ssh 解析 -o Key=Value 时会在**空格处截断值**，
		// 而 userData 目录名（"OCS Desktop"）带空格，不加引号 ssh 会拿到一个
		// 被截断的路径、读不到文件，然后报
		// "No ED25519 host key is known ... strict checking" 并拒绝连接。
		// 实测：裸路径 ✗、加双引号 ✓、反斜杠转义 ✗。
		'-o',
		`UserKnownHostsFile="${knownHostsPath()}"`,
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
		// 连接前把「私钥 ↔ 公钥」理一致。放在这里而不是 spawnTunnel 里，
		// 因为要跑 ssh-keygen，是异步操作
		await verifyKeyPair(resolveKeyPath(config));
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
	/** 公钥指纹，可与 VPS 上 `ssh-keygen -lf ~/.ssh/authorized_keys` 的输出对照 */
	publicKeyFingerprint: string | null;
	/** 密钥文件的问题（如私钥与公钥不配对），没有问题时为 null */
	keyIssue: string | null;
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
	const publicKey = readPublicKey();
	return {
		config: getSshTunnelConfig(),
		state,
		stateText: STATE_TEXT[state],
		lastError,
		publicKey,
		publicKeyFingerprint: keyFingerprint(publicKey),
		keyIssue,
		keyPath: resolveKeyPath(getSshTunnelConfig()),
		remotePort: store.store.remoteApi?.port ?? 15320,
		uptimeMs: state === 'running' && startedAt ? Date.now() - startedAt : 0
	};
}
