import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';

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

/** DSH 配置根目录：优先 DSH_HOME，否则 ~/.dsh */
export function dshHome(): string {
	const fromEnv = (process.env.DSH_HOME || '').trim();
	return fromEnv || path.join(os.homedir(), '.dsh');
}

/**
 * 桥接脚本所在目录。
 *
 * - 打包后：`<resources>/tools/ocs-openclaw`（electron.builder.json 里用 extraResources 带上的）
 * - 开发时：仓库里的 `tools/ocs-openclaw`
 */
export function bundledBridgeDir(): string {
	return app.isPackaged
		? path.join(process.resourcesPath, 'tools', 'ocs-openclaw')
		: path.resolve(app.getAppPath(), '../../tools/ocs-openclaw');
}

export interface DshStatus {
	/** DSH 配置根目录 */
	home: string;
	/** ~/.dsh 是否存在（没装 DSH 就是 false） */
	exists: boolean;
	/** 可选的 profile 名 */
	profiles: string[];
	/** 已经写过 OCS 受管块的 profile */
	configured: string[];
	/** 桥接脚本目录 */
	bridgeDir: string;
	/** 桥接脚本是否齐全 */
	bridgeReady: boolean;
}

/** 检测本机的 DSH 与桥接脚本 */
export function detectDsh(): DshStatus {
	const home = dshHome();
	const profilesDir = path.join(home, 'profiles');
	let profiles: string[] = [];
	let exists = false;
	try {
		if (fs.existsSync(profilesDir)) {
			exists = true;
			profiles = fs
				.readdirSync(profilesDir, { withFileTypes: true })
				.filter((item) => item.isDirectory())
				.map((item) => item.name)
				.filter((name) => PROFILE_RE.test(name))
				.sort();
		} else if (fs.existsSync(home)) {
			exists = true;
		}
	} catch {
		// 读不到就当没装；下面会把状态原样回给界面
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

	const bridgeDir = bundledBridgeDir();
	return {
		home,
		exists,
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

	// DSH 配置根目录：默认 ~/.dsh，可在界面上指定（比如 DSH 跑在别的用户下）
	const home = (input?.dshHome || '').trim() || dshHome();
	if (!path.isAbsolute(home)) {
		throw new Error('DSH 目录必须是绝对路径');
	}

	const file = path.join(home, 'profiles', profile, 'cordis.patch.yml');
	if (!fs.existsSync(file)) {
		throw new Error(`找不到 DSH 配置：${file}（profile 名对不对？）`);
	}

	const block = renderManagedBlock({
		bridgeDir,
		ocsBase,
		apiKey,
		certFingerprint: input?.certFingerprint
	});

	const existing = fs.readFileSync(file, 'utf8');
	const next = upsertManagedBlock(existing, block);

	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
	const backup = `${file}.bak-${stamp}`;
	fs.copyFileSync(file, backup);

	// 里面有密钥：写的时候就把权限收到 600（Windows 上基本是空操作）
	fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// 某些文件系统不支持 chmod，不影响配置本身
	}

	return { file, backup };
}
