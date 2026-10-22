#!/usr/bin/env bash
#
# 让 DSH 的飞书机器人也能使用 /ocs 命令（本地执行，不经过模型）。
#
# DSH 的 IM 插件实际加载的是打包产物 lib/index.js（不是 src）。本脚本在
# 飞书桥接的命令分支里插入一段拦截：遇到 `/ocs ...` 就调用 Harness 的命令
# 网关执行，并把结果直接回复到聊天。
#
# 注意：这是**对第三方插件打包产物的补丁**。插件升级后会被覆盖，重新执行
# 本脚本即可。脚本带备份，`--revert` 可恢复最近一次备份。
#
# 用法：
#   sudo bash patch-im-bridge.sh [--profile web] [--dsh-home /root/.dsh]
#   sudo bash patch-im-bridge.sh --revert
#
set -euo pipefail

DSH_HOME="${DSH_HOME:-/root/.dsh}"
PROFILE='web'
MODE='apply'

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--profile) PROFILE="$2"; shift 2 ;;
		--dsh-home) DSH_HOME="$2"; shift 2 ;;
		--revert) MODE='revert'; shift ;;
		-h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) fail "未知参数：$1" ;;
	esac
done

if [ -d "$DSH_HOME/.dsh/profiles" ]; then
	DSH_HOME="$DSH_HOME/.dsh"
fi
[ -d "$DSH_HOME/profiles/$PROFILE" ] || fail "找不到 profile：$DSH_HOME/profiles/$PROFILE"

FILE="$DSH_HOME/profiles/$PROFILE/node_modules/@xmanrui/dsh-im/lib/index.js"
[ -f "$FILE" ] || fail "找不到飞书插件打包文件：$FILE（先确认 IM 插件已安装）"

command -v node >/dev/null 2>&1 || fail '需要 node 来修改并校验插件文件'

step "$([ "$MODE" = revert ] && echo '恢复备份' || echo '插入 /ocs 拦截')"

node - "$FILE" "$MODE" <<'JS'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const file = process.argv[2];
const mode = process.argv[3] || 'apply';
const START = '/* ocs-im:start */';
const END = '/* ocs-im:end */';
const ANCHOR = 'if(d==="/compact"){';

if (mode === 'revert') {
	const dir = path.dirname(file);
	const base = path.basename(file);
	const backups = fs
		.readdirSync(dir)
		.filter((name) => name.startsWith(base + '.bak-'))
		.sort();
	if (!backups.length) {
		console.error('没有找到备份文件');
		process.exit(1);
	}
	// 取最早的一份：多次执行 apply 会把“已打补丁的文件”也备份进去，
	// 最近一份可能仍然带补丁
	fs.copyFileSync(path.join(dir, backups[0]), file);
	console.log('已恢复：' + path.join(dir, backups[0]));
	process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
let backup = file + '.bak-' + stamp;
let seq = 1;
while (fs.existsSync(backup)) {
	backup = file + '.bak-' + stamp + '-' + seq;
	seq += 1;
}
fs.copyFileSync(file, backup);
console.log('备份：' + backup);

let source = fs.readFileSync(file, 'utf8');

// 幂等：先移除旧的受管块
const startAt = source.indexOf(START);
if (startAt >= 0) {
	const endAt = source.indexOf(END, startAt);
	if (endAt < 0) {
		console.error('发现不完整的受管块，未修改文件');
		process.exit(2);
	}
	source = source.slice(0, startAt) + source.slice(endAt + END.length);
}

const anchorCount = source.split(ANCHOR).length - 1;
if (anchorCount !== 1) {
	console.error('飞书命令分支锚点数量异常：' + anchorCount + '（插件版本可能已变化）');
	process.exit(3);
}

// 压缩作用域里的变量名（来自 lib 中 /status、/compact 分支）：
//   d = 命令文本, A = 事件, o = 会话 key,
//   this.#A = harness, this.#r = state, this.#m = signal, this.#P = 发送
const block = [
	START,
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
	END
].join('');

source = source.replace(ANCHOR, block + ANCHOR);
fs.writeFileSync(file, source, 'utf8');

try {
	execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
} catch {
	console.error('语法检查失败，正在回滚');
	fs.copyFileSync(backup, file);
	process.exit(4);
}
console.log('已写入并通过语法检查');
JS

if [ "$MODE" = 'revert' ]; then
	info '已恢复原始文件，重启 DSH 后生效'
	exit 0
fi

step '下一步'
cat <<TIP
  重启 DSH，然后在飞书私聊里发送：

      /ocs 帮助

  撤销补丁：sudo bash $0 --revert
TIP
