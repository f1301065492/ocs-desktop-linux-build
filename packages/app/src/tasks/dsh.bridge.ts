import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';

const execFileAsync = promisify(execFile);

/**
 * DSH（DeepSeek Harness）接入：把 OCS 的 MCP 桥接写进 DSH 的配置。
 *
 * 背景：桥接脚本随应用一起发布（打包时放在 resources/tools/ocs-openclaw），
 * 用户不需要再手工拷脚本、手改 YAML。设置页点一下，这里负责把配置写对。
 *
 * 写的是一段**带起止标记**的受管块：重复执行只替换标记之间的内容，
 * 不会把同一个 MCP server 配出好几份（DSH 遇到重名 serverName 会直接报错）。
 */

/** 受管块起止标记（改这里要同步改 README 里的说明与 setup-same-host.sh） */
export const DSH_MARK_START = '# >>> ocs-mcp (managed by OCS Desktop) >>>';
export const DSH_MARK_END = '# <<< ocs-mcp <<<';

/** profile 名只允许安全字符，避免拼接出目录穿越 */
const PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 目录探测结果：把「没这个目录」和「有但没权限」分开——跨用户部署时后者是常态 */
export interface DirProbe {
	path: string;
	exists: boolean;
	readable: boolean;
	hasProfiles: boolean;
}

interface StatKind {
	exists: boolean;
	dir: boolean;
	denied: boolean;
}

function statKind(target: string): StatKind {
	try {
		const stat = fs.statSync(target);
		return { exists: true, dir: stat.isDirectory(), denied: false };
	} catch (err) {
		const code = (err as { code?: string })?.code;
		// /root 是 0700：其他用户 stat 它的子项会 EACCES，但目录其实是存在的
		if (code === 'EACCES' || code === 'EPERM') {
			return { exists: true, dir: false, denied: true };
		}
		return { exists: false, dir: false, denied: false };
	}
}

function probeDataRoot(dir: string): DirProbe {
	const self = statKind(dir);
	if (!self.exists) {
		return { path: dir, exists: false, readable: false, hasProfiles: false };
	}
	if (self.denied || !self.dir) {
		return { path: dir, exists: true, readable: false, hasProfiles: false };
	}
	const profiles = statKind(path.join(dir, 'profiles'));
	return {
		path: dir,
		exists: true,
		readable: !profiles.denied,
		hasProfiles: profiles.exists && profiles.dir && !profiles.denied
	};
}

/**
 * 候选目录可能是数据目录（里面有 `profiles/`），也可能是安装目录（数据在它下面的 `.dsh/`）。
 * 连读都读不了时不再往下钻——否则会得出 `/root/.dsh/.dsh` 这种假路径。
 */
function probeDshDir(raw: string): DirProbe {
	const dir = (raw || '').trim();
	if (!dir) {
		return { path: '', exists: false, readable: false, hasProfiles: false };
	}
	const direct = probeDataRoot(dir);
	if (!direct.exists || direct.hasProfiles || !direct.readable) {
		return direct;
	}
	const nested = probeDataRoot(path.join(dir, '.dsh'));
	return nested.exists ? nested : direct;
}

interface PasswdEntry {
	name: string;
	home: string;
}

function readPasswd(passwdPath: string): Record<number, PasswdEntry> {
	const map: Record<number, PasswdEntry> = {};
	let text: string;
	try {
		text = fs.readFileSync(passwdPath, 'utf8');
	} catch {
		return map;
	}
	for (const line of text.split(/\r?\n/)) {
		const parts = line.split(':');
		if (parts.length < 7) {
			continue;
		}
		const uid = Number(parts[2]);
		if (!Number.isInteger(uid)) {
			continue;
		}
		map[uid] = { name: parts[0], home: parts[5] };
	}
	return map;
}

function readProcessUid(statusPath: string): number | undefined {
	try {
		const match = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(statusPath, 'utf8'));
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

function readProcessEnviron(environPath: string): Record<string, string> | undefined {
	try {
		const env: Record<string, string> = {};
		for (const pair of fs.readFileSync(environPath).toString('utf8').split('\0')) {
			const index = pair.indexOf('=');
			if (index > 0) {
				env[pair.slice(0, index)] = pair.slice(index + 1);
			}
		}
		return env;
	} catch {
		return undefined;
	}
}

function looksLikeDsh(cmdline: string): boolean {
	return (
		/(^|[/\s])dsh(\s|$)/.test(cmdline) || cmdline.includes('deepseek-harness') || cmdline.includes('deepseek_harness')
	);
}

export interface DshProcess {
	pid: number;
	/** 运行 DSH 的用户名（从 /proc/<pid>/status 的 Uid 反查 /etc/passwd） */
	user?: string;
	/** 该进程可能使用的数据目录：DSH_HOME 优先，其次运行用户的 ~/.dsh */
	homes: string[];
}

/**
 * 从运行中的进程反推 DSH 数据目录。
 *
 * 为什么需要：DSH 可能在**别的用户**下运行（比如 root），OCS 以普通用户跑时既看不到
 * 它的 `~/.dsh`（/root 是 0700），也读不了 `/proc/<pid>/environ` 里的 `DSH_HOME`；
 * 但 `/proc/<pid>/cmdline` 与 `/proc/<pid>/status` 任何人都能读，从 Uid 反查
 * `/etc/passwd` 就能拿到运行用户的 home → `<home>/.dsh`。
 *
 * @param procRoot 仅测试用，默认 /proc
 * @param passwdPath 仅测试用，默认 /etc/passwd
 */
export function discoverDshProcesses(procRoot = '/proc', passwdPath = '/etc/passwd'): DshProcess[] {
	if (!fs.existsSync(procRoot)) {
		return [];
	}
	let pids: string[];
	try {
		pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
	} catch {
		return [];
	}
	const passwd = readPasswd(passwdPath);
	const found: DshProcess[] = [];
	for (const pid of pids) {
		const dir = path.join(procRoot, pid);
		let cmdline: string;
		try {
			cmdline = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
		} catch {
			continue;
		}
		if (!looksLikeDsh(cmdline)) {
			continue;
		}
		const uid = readProcessUid(path.join(dir, 'status'));
		const entry = uid === undefined ? undefined : passwd[uid];
		const homes: string[] = [];
		const envHome = (readProcessEnviron(path.join(dir, 'environ'))?.DSH_HOME || '').trim();
		if (envHome) {
			homes.push(envHome);
		}
		if (entry?.home) {
			homes.push(path.join(entry.home, '.dsh'));
		}
		const unique = dedupe(homes);
		// uid 和环境都拿不到时这个进程给不出任何候选，不必记录
		if (unique.length > 0) {
			found.push({ pid: Number(pid), user: entry?.name, homes: unique });
		}
	}
	return found;
}

function dedupe(list: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of list) {
		const value = (item || '').trim();
		if (!value || seen.has(value)) {
			continue;
		}
		seen.add(value);
		out.push(value);
	}
	return out;
}

function buildCandidates(discovered: DshProcess[]): string[] {
	const list: string[] = [];
	// 运行中的进程最能说明问题：DSH_HOME 或运行用户的 ~/.dsh
	for (const proc of discovered) {
		list.push(...proc.homes);
	}
	const fromEnv = (process.env.DSH_HOME || '').trim();
	if (fromEnv) {
		list.push(fromEnv);
	}
	list.push(path.join(os.homedir(), '.dsh'));
	list.push('/root/deepseek-harness');
	list.push(path.join(os.homedir(), 'deepseek-harness'));
	// DSH 常以单独的普通用户运行：数据在各用户的 ~/.dsh 下（OCS 以 root 跑时最有用）
	if (process.platform !== 'win32') {
		try {
			for (const user of fs.readdirSync('/home')) {
				list.push(path.join('/home', user, '.dsh'));
			}
		} catch {
			// 没有 /home 或没权限：忽略
		}
	}
	return dedupe(list);
}

function currentUser(): string {
	try {
		return os.userInfo().username;
	} catch {
		return '';
	}
}

export interface DshBridgeOptions {
	/** ocs-mcp-server.mjs 所在目录 */
	bridgeDir: string;
	/** OCS 远程 API 地址，同机部署通常是 https://127.0.0.1:15320 */
	ocsBase: string;
	/** API 密钥明文（OCS 只存 scrypt 哈希，取不回原文，所以必须由用户提供或现场生成） */
	apiKey: string;
	/** 证书指纹，可为空 */
	certFingerprint?: string;
}

/** YAML 单引号字符串：路径里常有空格/中文，单引号不需要转义；值里的单引号双写 */
function yamlString(value: string): string {
	return `'${String(value).replace(/'/g, "''")}'`;
}

/** 生成要写进 DSH patch 层的受管块 */
export function renderManagedBlock(opts: DshBridgeOptions): string {
	return [
		DSH_MARK_START,
		'- insert:',
		'    - id: ocs-mcp',
		'      name: "@deepseek-ai/dsh-mcp-client"',
		'      config:',
		'        serverName: ocs',
		'        transport: stdio',
		'        command: node',
		`        args: [${yamlString(path.join(opts.bridgeDir, 'ocs-mcp-server.mjs'))}]`,
		`        cwd: ${yamlString(opts.bridgeDir)}`,
		'        env:',
		`          OCS_BASE: ${yamlString(opts.ocsBase)}`,
		`          OCS_API_KEY: ${yamlString(opts.apiKey)}`,
		`          OCS_CERT_SHA256: ${yamlString(opts.certFingerprint || '')}`,
		'        toolCallTimeoutMs: 30000',
		'        failOnStartupError: false',
		DSH_MARK_END
	].join('\n');
}

/**
 * 把受管块并进已有的 patch 内容。
 *
 * 先删掉旧的受管块（含标记），再在末尾追加新的；文件其余内容原样保留。
 * 这样重复点「写入」不会产生重复配置。
 */
export function upsertManagedBlock(existing: string, block: string): string {
	const kept: string[] = [];
	let inside = false;
	for (const line of String(existing || '').split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === DSH_MARK_START) {
			inside = true;
			continue;
		}
		if (trimmed === DSH_MARK_END) {
			inside = false;
			continue;
		}
		if (!inside) {
			kept.push(line);
		}
	}
	while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
		kept.pop();
	}
	if (kept.length === 0) {
		return block + '\n';
	}
	return [...kept, '', block, ''].join('\n');
}

/**
 * 默认 DSH 数据目录候选（按顺序试）。
 *
 * 顺序：运行中的 DSH 进程 → OCS 自己的 DSH_HOME → `~/.dsh` →
 * `/root/deepseek-harness` → `~/deepseek-harness` → 各用户的 `~/.dsh`。
 */
export function dshHomeCandidates(): string[] {
	return buildCandidates(discoverDshProcesses());
}

/** 默认 DSH 根目录（第一个候选；真正的挑选逻辑在 detectDsh / resolveDshHome） */
export function dshHome(): string {
	return dshHomeCandidates()[0];
}

/**
 * 把用户给的目录规范化成「DSH 数据目录」（里面有 `profiles/`）。兼容两种布局：
 *
 * - `<dir>/profiles`       → dir 本身就是数据目录（DSH_HOME 指向它，如 /root/deepseek-harness）
 * - `<dir>/.dsh/profiles`  → dir 是安装目录，数据在它下面的 `.dsh/`
 *
 * 都不匹配时原样返回，由调用方给出「找不到配置」的明确错误。
 */
export function resolveDshHome(input?: string): string {
	const dir = (input || '').trim();
	if (!dir) {
		return dshHomeCandidates()[0] || path.join(os.homedir(), '.dsh');
	}
	if (probeDataRoot(dir).hasProfiles) {
		return dir;
	}
	const nested = path.join(dir, '.dsh');
	return probeDataRoot(nested).hasProfiles ? nested : dir;
}

/**
 * 桥接脚本所在目录。
 *
 * - 打包后：`<resources>/tools/ocs-openclaw`（electron.builder.json 里用 extraResources 带上的）
 * - 开发/测试时：仓库里的 `tools/ocs-openclaw`
 *
 * 这里刻意对 `app` 做防御：脱离 Electron 主进程跑单测时 `require('electron')` 拿到的是路径字符串，
 * `app` 为 undefined——此时退回仓库路径，而不是抛错。
 */
export function bundledBridgeDir(): string {
	const electronApp = app as unknown as { isPackaged?: boolean; getAppPath?: () => string } | undefined;
	if (electronApp?.isPackaged) {
		return path.join(process.resourcesPath, 'tools', 'ocs-openclaw');
	}
	const appPath = electronApp?.getAppPath?.() || process.cwd();
	return path.resolve(appPath, '../../tools/ocs-openclaw');
}

export interface DshStatus {
	/** DSH 配置根目录 */
	home: string;
	/** 目录是否存在（没装 DSH 就是 false） */
	exists: boolean;
	/** 当前 OCS 用户能否读取它（跨用户部署时会 false） */
	readable: boolean;
	/** 为什么找到 / 找不到：ok | missing | no-profiles | unreadable */
	reason: 'ok' | 'missing' | 'no-profiles' | 'unreadable';
	/** 运行 DSH 的用户（从运行中的进程反推，拿不到就没有） */
	dshUser?: string;
	/** 当前 OCS 进程的用户 */
	ocsUser: string;
	/** 可选的 profile 名（读不到时为空） */
	profiles: string[];
	/** 已经写过 OCS 受管块的 profile */
	configured: string[];
	/** 桥接脚本目录 */
	bridgeDir: string;
	/** 桥接脚本是否齐全 */
	bridgeReady: boolean;
}

/**
 * 检测本机的 DSH 与桥接脚本。
 *
 * @param input 可选：用户在界面上指定的目录；不传就按 `dshHomeCandidates()` 逐个试
 *              （含从运行中的 DSH 进程反推出来的位置）。
 */
export function detectDsh(input?: string): DshStatus {
	const explicit = (input || '').trim();
	const discovered = explicit ? [] : discoverDshProcesses();
	const candidates = explicit ? [explicit] : buildCandidates(discovered);

	// 优先选「能读且里面有 profiles/」的；否则退而记录第一个存在的目录，
	// 这样跨用户时能明确告诉用户"找到了但读不了"，而不是笼统的"没检测到"
	let chosen: DirProbe | undefined;
	let firstExisting: DirProbe | undefined;
	for (const raw of candidates) {
		const probe = probeDshDir(raw);
		if (!probe.exists) {
			continue;
		}
		if (!firstExisting) {
			firstExisting = probe;
		}
		if (probe.readable && probe.hasProfiles) {
			chosen = probe;
			break;
		}
	}

	const result = chosen || firstExisting;
	const home = result?.path || candidates[0] || '';
	const exists = Boolean(result?.exists);
	const readable = Boolean(result?.readable);
	const hasProfiles = Boolean(result?.hasProfiles);
	const reason: DshStatus['reason'] = !exists
		? 'missing'
		: !readable
		? 'unreadable'
		: !hasProfiles
		? 'no-profiles'
		: 'ok';

	const profilesDir = path.join(home, 'profiles');
	let profiles: string[] = [];
	try {
		if (readable && fs.existsSync(profilesDir)) {
			profiles = fs
				.readdirSync(profilesDir, { withFileTypes: true })
				.filter((item) => item.isDirectory())
				.map((item) => item.name)
				.filter((name) => PROFILE_RE.test(name))
				.sort();
		}
	} catch {
		// 读不到就当没有；下面会把状态原样回给界面
	}

	const configured: string[] = [];
	for (const profile of profiles) {
		try {
			const patch = fs.readFileSync(path.join(profilesDir, profile, 'cordis.patch.yml'), 'utf8');
			if (patch.includes(DSH_MARK_START)) {
				configured.push(profile);
			}
		} catch {
			// profile 里没有 patch 文件：自然也算没配过
		}
	}

	const matchedProc = discovered.find(
		(proc) => proc.homes.includes(home) || proc.homes.includes(path.join(home, '.dsh'))
	);
	const dshUser = matchedProc?.user || discovered[0]?.user;

	const bridgeDir = bundledBridgeDir();
	return {
		home,
		exists,
		readable,
		reason,
		dshUser,
		ocsUser: currentUser(),
		profiles,
		configured,
		bridgeDir,
		bridgeReady: fs.existsSync(path.join(bridgeDir, 'ocs-mcp-server.mjs'))
	};
}

export interface DshWriteInput {
	profile: string;
	ocsBase: string;
	apiKey: string;
	certFingerprint?: string;
	/** 可选：覆盖桥接目录（默认用随应用发布的） */
	bridgeDir?: string;
	/** 可选：覆盖 DSH 配置根目录（DSH 跑在别的用户下时用） */
	dshHome?: string;
}

export interface DshWriteResult {
	/** 写入的配置文件 */
	file: string;
	/** 覆盖前的备份 */
	backup: string;
}

/**
 * 把受管块写进指定 profile 的 cordis.patch.yml。
 *
 * 出错一律抛异常（渲染进程的 remote.call 会 reject 并把消息提示出来），
 * 不静默失败——配置写歪了用户是看不出来的。
 */
export function writeDshProfile(input: DshWriteInput): DshWriteResult {
	const profile = String(input?.profile || '').trim();
	if (!PROFILE_RE.test(profile)) {
		throw new Error('profile 名不合法（只允许字母、数字、下划线、连字符）');
	}
	const ocsBase = String(input?.ocsBase || '').trim();
	if (!/^https?:\/\//i.test(ocsBase)) {
		throw new Error('OCS 地址必须以 http(s):// 开头');
	}
	const apiKey = String(input?.apiKey || '').trim();
	if (apiKey.length === 0) {
		throw new Error('API 密钥不能为空（OCS 只保存哈希，没法自动取回明文）');
	}

	const bridgeDir = (input?.bridgeDir || bundledBridgeDir()).trim();
	if (!fs.existsSync(path.join(bridgeDir, 'ocs-mcp-server.mjs'))) {
		throw new Error(`桥接脚本不存在：${path.join(bridgeDir, 'ocs-mcp-server.mjs')}`);
	}

	// DSH 数据目录：默认自动探测，也可在界面上指定（比如 /root/deepseek-harness）
	const home = resolveDshHome(input?.dshHome);
	if (!path.isAbsolute(home)) {
		throw new Error('DSH 目录必须是绝对路径');
	}

	const file = path.join(home, 'profiles', profile, 'cordis.patch.yml');
	if (!fs.existsSync(file)) {
		throw new Error(
			`找不到 DSH 配置：${file}\n` +
				`（${home} 里没有 profiles/。若 DSH 由其他用户运行，OCS 可能看不到它的数据目录——` +
				`用运行 DSH 的用户执行 setup-same-host.sh 更省事）`
		);
	}

	const block = renderManagedBlock({
		bridgeDir,
		ocsBase,
		apiKey,
		certFingerprint: input?.certFingerprint
	});

	let existing: string;
	try {
		existing = fs.readFileSync(file, 'utf8');
	} catch (err) {
		throw new Error(permissionHint(err, file));
	}
	const next = upsertManagedBlock(existing, block);

	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
	const backup = `${file}.bak-${stamp}`;
	try {
		fs.copyFileSync(file, backup);
		// 里面有密钥：写的时候就把权限收到 600
		fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
	} catch (err) {
		throw new Error(permissionHint(err, file));
	}
	// 跨用户授权（ACL）场景下，写是允许的，但 chmod 只有属主能做——失败不应让整次写入报错
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// 不是属主：保持原权限即可（文件本来就只对属主/root/被授权者开放）
	}

	return { file, backup };
}

/** 生成给用户手工执行的单行命令（整段脚本单引号包裹） */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 用户名只允许安全字符，避免拼进 shell 脚本 */
const GRANT_USER_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

/**
 * 构造给 DSH 数据目录授权用的 POSIX ACL 脚本。
 *
 * 目标：让**运行 OCS 的用户**能读/写 `<home>/profiles` 下的配置，从而在设置页直接
 * 读写 DSH 的 `cordis.patch.yml`，即使 DSH 是另一个用户（典型是 root）跑的。
 *
 * - 祖先目录只加 `x`（可穿透，不能列目录），不改属主/权限位；
 * - profiles 及其子项加 `rwX`（目录可进入、文件可读写）；
 * - 目录加默认 ACL，DSH 之后新建的 profile/备份也自动继承（仅对 OCS 用户）。
 *
 * 这是**一次性**授权：执行后无需 sudo 就能反复改配置。撤销用
 * `setfacl -R -x u:<user> <home>/profiles`（以及祖先目录上的 `-x u:<user>`）。
 */
export function buildAclScript(home: string, user: string): string {
	if (!path.isAbsolute(home) || /[\0\n\r]/.test(home)) {
		throw new Error('DSH 目录必须是绝对路径，且不能包含换行');
	}
	if (!GRANT_USER_RE.test(user)) {
		throw new Error(`用户名不合法：${user}`);
	}
	const quote = shellQuote;
	const ancestors: string[] = [];
	let dir = path.dirname(home);
	while (dir && dir !== '/' && dir !== path.dirname(dir)) {
		ancestors.unshift(dir);
		dir = path.dirname(dir);
	}
	const profiles = path.join(home, 'profiles');
	const lines = ['set -e'];
	for (const ancestor of ancestors) {
		lines.push(`/usr/bin/setfacl -m u:${user}:x ${quote(ancestor)}`);
	}
	lines.push(`/usr/bin/setfacl -m u:${user}:x ${quote(home)}`);
	lines.push(`/usr/bin/setfacl -m u:${user}:rx ${quote(profiles)}`);
	lines.push(`/usr/bin/setfacl -R -m u:${user}:rwX ${quote(profiles)}`);
	lines.push(`/usr/bin/find ${quote(profiles)} -type d -exec /usr/bin/setfacl -d -m u:${user}:rwX {} +`);
	return lines.join('\n');
}

export interface DshGrantInput {
	/** 可选：用户在界面上指定的 DSH 数据目录 */
	dshHome?: string;
}

export interface DshGrantResult {
	ok: boolean;
	/** 授权成功后重新检测到的状态 */
	status?: DshStatus;
	/** 自动授权失败时，给用户复制到手执行的一条命令 */
	command?: string;
	message?: string;
}

/**
 * 让当前 OCS 用户获得 DSH 数据目录的读写权限（跨用户场景）。
 *
 * 通过 `pkexec` 弹系统认证框执行 setfacl（polkit 授权），只做 ACL，不改文件属主。
 * 无图形会话 / 没有 polkit 认证代理时会失败，此时返回可复制的 sudo 命令。
 * 仅 Linux：Windows/macOS 不存在这种跨用户目录权限模型。
 */
export async function grantDshAccess(input?: DshGrantInput): Promise<DshGrantResult> {
	if (process.platform !== 'linux') {
		return { ok: false, message: '该功能仅支持 Linux（依赖 POSIX ACL 与 polkit）' };
	}
	const home = resolveDshHome(input?.dshHome);
	if (!path.isAbsolute(home) || !fs.existsSync(path.join(home, 'profiles'))) {
		return { ok: false, message: `找不到 DSH 数据目录：${home}` };
	}
	const user = currentUser();
	let script: string;
	try {
		script = buildAclScript(home, user);
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
	const manual = `sudo /bin/sh -c ${shellQuote(script)}`;

	try {
		await execFileAsync('/usr/bin/pkexec', ['/bin/sh', '-c', script], { timeout: 120000 });
	} catch (err) {
		const detail = String(
			(err as { stderr?: string; message?: string })?.stderr || (err as Error)?.message || err
		).trim();
		return {
			ok: false,
			command: manual,
			message: `自动授权失败：${detail}`
		};
	}
	return { ok: true, status: detectDsh(home) };
}

/** 把权限类错误翻译成能直接照做的提示 */
function permissionHint(err: unknown, file: string): string {
	const code = (err as { code?: string })?.code;
	const message = err instanceof Error ? err.message : String(err);
	if (code === 'EACCES' || code === 'EPERM') {
		const dshUser = discoverDshProcesses()[0]?.user;
		const ocsUser = currentUser();
		const who = dshUser ? `DSH 由 ${dshUser} 运行，而 OCS 当前用户是 ${ocsUser}。` : `OCS 和 DSH 是不是不同的用户？`;
		return (
			`没有权限写入 ${file}（${code}）。` +
			`${who}要么用运行 DSH 的同一个用户跑 OCS，要么用 root 执行 setup-same-host.sh（设置页里有可复制的命令）。`
		);
	}
	return `写入 ${file} 失败：${message}`;
}
