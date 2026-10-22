import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../logger';
import { resolveDshHome } from './dsh.bridge';

const execFileAsync = promisify(execFile);

let cachedLogger: ReturnType<typeof Logger> | null = null;
function getLogger(): ReturnType<typeof Logger> {
	if (!cachedLogger) {
		try {
			cachedLogger = Logger('dsh-im');
		} catch {
			cachedLogger = console as unknown as ReturnType<typeof Logger>;
		}
	}
	return cachedLogger;
}

/**
 * 让飞书机器人支持 `/ocs` 命令（本地执行、不经过模型）。
 *
 * DSH 的 IM 插件实际加载的是打包产物 `lib/index.js`（package.json main），
 * 不是 `src/`。这里在飞书桥接的命令分支里插入一段拦截；IM 插件升级会覆盖，
 * 所以做成设置页可重复执行的一键操作。
 */

const MARK_START = '/* ocs-im:start */';
const MARK_END = '/* ocs-im:end */';
const ANCHOR = 'if(d==="/compact"){';
const PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;

const PATCH_BLOCK = [
	MARK_START,
	'if(/^\\/ocs(?:\\s|$)/i.test(String(d||"").trim())){',
	'const _ocsSession=typeof this.#r?.sessionFor==="function"?this.#r.sessionFor(o):null;',
	'if(typeof _ocsSession!=="string"||!_ocsSession){await this.#P(A.message.chat_id,"当前聊天还没有会话，请先发送一条普通消息再使用 /ocs。",{replyTo:A.message.message_id});return}',
	'try{let _ocsExec;',
	'if(typeof this.#A?.workspaceSession==="function"){const _ocsScoped=this.#A.workspaceSession(_ocsSession,o);_ocsExec=typeof _ocsScoped?.executeCommand==="function"?await _ocsScoped.executeCommand(String(d).trim(),{signal:this.#m}):void 0}',
	'else if(typeof this.#A?.executeCommand==="function"){_ocsExec=await this.#A.executeCommand(_ocsSession,String(d).trim(),{signal:this.#m})}',
	'if(!_ocsExec){await this.#P(A.message.chat_id,"当前 Harness 不支持从机器人执行命令。",{replyTo:A.message.message_id});return}',
	'const _ocsResult=_ocsExec.result;',
	'const _ocsText=(_ocsResult&&_ocsResult.text)||(_ocsResult&&_ocsResult.kind==="error"?"命令执行失败":"命令已执行");',
	'await this.#P(A.message.chat_id,_ocsText,{replyTo:A.message.message_id})',
	'}catch(_ocsErr){await this.#P(A.message.chat_id,"执行 /ocs 失败："+(_ocsErr?.message||String(_ocsErr)),{replyTo:A.message.message_id})}',
	'return}',
	MARK_END
].join('');

export interface ImPatchInput {
	dshHome?: string;
	profile?: string;
}

export interface ImPatchStatus {
	/** 飞书桥接打包文件 */
	file: string;
	/** 文件是否存在（IM 插件是否安装） */
	exists: boolean;
	/** 是否已写入受管补丁 */
	patched: boolean;
	/** 当前用户是否可写（跨用户时可能为 false） */
	writable: boolean;
}

function bridgeFile(input?: ImPatchInput): { file: string; profile: string } {
	const profile = String(input?.profile || 'web').trim();
	if (!PROFILE_RE.test(profile)) {
		throw new Error('profile 名不合法（只允许字母、数字、下划线、连字符）');
	}
	const home = resolveDshHome(input?.dshHome);
	const file = path.join(home, 'profiles', profile, 'node_modules', '@xmanrui', 'dsh-im', 'lib', 'index.js');
	return { file, profile };
}

export function imPatchStatus(input?: ImPatchInput): ImPatchStatus {
	let file = '';
	try {
		file = bridgeFile(input).file;
	} catch (err) {
		return { file: '', exists: false, patched: false, writable: false };
	}
	let exists = false;
	let patched = false;
	let writable = false;
	try {
		exists = fs.existsSync(file);
		if (exists) {
			patched = fs.readFileSync(file, 'utf8').includes(MARK_START);
			try {
				fs.accessSync(file, fs.constants.W_OK);
				writable = true;
			} catch {
				writable = false;
			}
		}
	} catch {
		// 读不到就按不存在处理，界面会给出提示
	}
	return { file, exists, patched, writable };
}

async function checkSyntax(file: string): Promise<void> {
	try {
		await execFileAsync('/usr/bin/node', ['--check', file]);
		return;
	} catch (err) {
		const code = (err as { code?: string })?.code;
		if (code !== 'ENOENT') {
			throw err;
		}
	}
	// 没有系统 node：用软件自带的 Electron 以 Node 模式做语法检查
	await execFileAsync(process.execPath, ['--check', file], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
	});
}

function uniqueBackup(file: string): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
	let backup = `${file}.bak-${stamp}`;
	let seq = 1;
	while (fs.existsSync(backup)) {
		backup = `${file}.bak-${stamp}-${seq}`;
		seq += 1;
	}
	return backup;
}

export interface ImPatchResult {
	file: string;
	backup: string;
	patched: boolean;
}

/**
 * 写入 / 修复飞书桥接补丁（幂等）。
 *
 * 出错一律抛异常，渲染进程会提示；写坏时自动回滚到备份。
 */
export async function patchImBridge(input?: ImPatchInput): Promise<ImPatchResult> {
	const { file } = bridgeFile(input);
	if (!fs.existsSync(file)) {
		throw new Error(`没有找到 IM 插件：${file}（先在 DSH 里安装并启用飞书机器人）`);
	}

	let source: string;
	try {
		source = fs.readFileSync(file, 'utf8');
	} catch (err) {
		throw new Error(permissionHint(err, file));
	}

	// 幂等：先移除旧的受管块
	const startAt = source.indexOf(MARK_START);
	if (startAt >= 0) {
		const endAt = source.indexOf(MARK_END, startAt);
		if (endAt < 0) {
			throw new Error('发现不完整的受管块，未修改文件（请先恢复 IM 插件或重装）');
		}
		source = source.slice(0, startAt) + source.slice(endAt + MARK_END.length);
	}

	const anchorCount = source.split(ANCHOR).length - 1;
	if (anchorCount !== 1) {
		throw new Error(`飞书命令分支锚点数量异常（${anchorCount}），IM 插件版本可能已变化，暂不写入`);
	}

	source = source.replace(ANCHOR, PATCH_BLOCK + ANCHOR);

	const backup = uniqueBackup(file);
	try {
		fs.copyFileSync(file, backup);
		fs.writeFileSync(file, source, 'utf8');
	} catch (err) {
		throw new Error(permissionHint(err, file));
	}

	try {
		await checkSyntax(file);
	} catch (err) {
		try {
			fs.copyFileSync(backup, file);
		} catch {
			// 回滚失败也把原始错误抛出去
		}
		const detail = (err as { stderr?: string; message?: string })?.stderr || (err as Error)?.message || String(err);
		throw new Error(`语法检查失败，已回滚：${String(detail).trim().slice(0, 500)}`);
	}

	getLogger().info(`已写入 IM 桥接补丁：${file}`);
	return { file, backup, patched: true };
}

function permissionHint(err: unknown, file: string): string {
	const code = (err as { code?: string })?.code;
	const message = err instanceof Error ? err.message : String(err);
	if (code === 'EACCES' || code === 'EPERM') {
		return (
			`没有权限写入 ${file}（${code}）。` +
			`OCS 与 DSH 可能是不同用户：先在「DSH 目录」点「授权 OCS 访问」，或让 OCS 以运行 DSH 的用户启动。`
		);
	}
	return `写入 ${file} 失败：${message}`;
}
