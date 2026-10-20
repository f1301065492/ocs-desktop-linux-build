#!/usr/bin/env bash
#
# 同机部署一键配置：把 OCS 的 MCP 接进本机的 DSH。
#
# 做的事：
#   1. 检查 node、桥接脚本、OCS 的健康检查（https://127.0.0.1:15320）
#   2. 拿到证书指纹（可用就填上）
#   3. 在 ~/.dsh/profiles/<profile>/cordis.patch.yml 里写入/更新一段带标记的 ocs-mcp 配置
#      （先备份；同一段标记会被替换，可反复执行）
#   4. 用真实密钥跑一次 check-ocs.mjs 验证（可加 --no-verify 跳过）
#
# 用法：
#   ./setup-same-host.sh                       # 交互式：列 profile、要密钥
#   ./setup-same-host.sh --profile web         # 指定 profile
#   ./setup-same-host.sh --key 'xxx'           # 非交互（注意 shell 历史）
#   ./setup-same-host.sh --bridge-dir /opt/ocs-bridge --dsh-home ~/.dsh
#
# 说明：默认只改 patch 层，不动 DSH 本体；重启 DSH 后生效。
set -euo pipefail

MARK_START='# >>> ocs-mcp (managed by setup-same-host.sh) >>>'
MARK_END='# <<< ocs-mcp <<<'

BRIDGE_DIR='/opt/ocs-bridge'
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE=''
API_KEY=''
OCS_BASE='https://127.0.0.1:15320'
VERIFY=1

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--profile) PROFILE="$2"; shift 2 ;;
		--key) API_KEY="$2"; shift 2 ;;
		--bridge-dir) BRIDGE_DIR="$2"; shift 2 ;;
		--dsh-home) DSH_HOME="$2"; shift 2 ;;
		--ocs-base) OCS_BASE="$2"; shift 2 ;;
		--no-verify) VERIFY=0; shift ;;
		-h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) fail "未知参数：$1" ;;
	esac
done

# ---------- 1. 环境检查 ----------
step '1. 环境检查'
command -v node >/dev/null 2>&1 || fail '找不到 node。DSH 依赖 Node，先确认它在 PATH 里（which node）'
info "node: $(command -v node) ($(node -v))"
[ -f "$BRIDGE_DIR/ocs-mcp-server.mjs" ] || fail "桥接脚本不在 $BRIDGE_DIR（先把 tools/ocs-openclaw/ 拷过去，或用 --bridge-dir 指定）"
info "桥接脚本: $BRIDGE_DIR/ocs-mcp-server.mjs"
[ -d "$DSH_HOME/profiles" ] || fail "$DSH_HOME/profiles 不存在：DSH 没装在这个用户下？检查 --dsh-home"

# ---------- 2. OCS 连通性 ----------
step '2. OCS 健康检查'
HEALTH="$(curl -k -s -m 8 "$OCS_BASE/api/v1/health" || true)"
if [ -z "$HEALTH" ]; then
	fail "连不上 $OCS_BASE。确认 OCS 正在运行、远程 API 已开启且监听 127.0.0.1:15320"
fi
read -r LISTENING RENDERER FINGERPRINT <<<"$(printf '%s' "$HEALTH" | node -e '
const chunks=[];process.stdin.on("data",c=>chunks.push(c)).on("end",()=>{
  try{const d=JSON.parse(Buffer.concat(chunks).toString("utf8")).data||{};
  process.stdout.write([d.listening?"yes":"no",d.rendererReady?"yes":"no",d.certFingerprint||"-"].join(" "));}
  catch{process.stdout.write("parse-fail parse-fail -");}
});')"
info "远程 API 监听: $LISTENING ｜ 渲染进程就绪: $RENDERER ｜ 证书指纹: $FINGERPRINT"
[ "$LISTENING" = 'yes' ] || fail 'OCS 远程 API 没在监听：设置 → 远程 API 打开开关'
[ "$FINGERPRINT" != '-' ] || FINGERPRINT=''

# ---------- 3. 选 profile ----------
step '3. 选择 DSH profile'
if [ -z "$PROFILE" ]; then
	mapfile -t PROFILES < <(find "$DSH_HOME/profiles" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
	if [ "${#PROFILES[@]}" -eq 0 ]; then
		fail "$DSH_HOME/profiles 下没有 profile"
	elif [ "${#PROFILES[@]}" -eq 1 ]; then
		PROFILE="${PROFILES[0]}"
		info "只有一个 profile，用它：$PROFILE"
	else
		info "发现多个 profile：${PROFILES[*]}"
		read -rp '  请输入要配置的 profile 名: ' PROFILE
	fi
fi
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
[ -f "$PATCH" ] || fail "$PATCH 不存在（profile 名对不对？）"
info "目标文件: $PATCH"

# ---------- 4. 密钥 ----------
step '4. OCS API 密钥'
if [ -z "$API_KEY" ]; then
	printf '  粘贴密钥（输入不回显，来自 OCS 设置 → 远程 API；留空则写占位符）：'
	read -rsp '' API_KEY || true
	printf '\n'
fi
if [ -z "$API_KEY" ]; then
	API_KEY='在这里填密钥（OCS 设置 → 远程 API）'
	info '没填密钥，先写占位符——填好后重启 DSH 即可'
else
	info '已拿到密钥'
fi

# ---------- 5. 写入配置 ----------
step '5. 写入 DSH 配置'
BACKUP="$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
cp "$PATCH" "$BACKUP"
info "已备份: $BACKUP"

TMP_FILE="$(mktemp)"
# 删掉旧的受管块（如果之前跑过），其余内容原样保留
awk -v s="$MARK_START" -v e="$MARK_END" '
	$0 == s { skip=1; next }
	$0 == e { skip=0; next }
	skip != 1 { print }
' "$PATCH" >"$TMP_FILE"

cat >>"$TMP_FILE" <<YAML

$MARK_START
- insert:
    - id: ocs-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: ocs
        transport: stdio
        command: node
        args: ['$BRIDGE_DIR/ocs-mcp-server.mjs']
        cwd: '$BRIDGE_DIR'
        env:
          OCS_BASE: '$OCS_BASE'
          OCS_API_KEY: '$API_KEY'
          OCS_CERT_SHA256: '$FINGERPRINT'
        toolCallTimeoutMs: 30000
        failOnStartupError: false
$MARK_END
YAML

mv "$TMP_FILE" "$PATCH"
chmod 600 "$PATCH"   # 里面有密钥
info "已写入（文件权限设为 600）"

# ---------- 6. 用真实密钥验一次 ----------
if [ "$VERIFY" -eq 1 ] && [ "${API_KEY#在这里填密钥}" = "$API_KEY" ]; then
	step '6. 用真实密钥自检'
	if ( cd "$BRIDGE_DIR" && OCS_BASE="$OCS_BASE" OCS_API_KEY="$API_KEY" OCS_CERT_SHA256="$FINGERPRINT" node check-ocs.mjs ); then
		info '自检通过'
	else
		printf '\n\033[33m! 自检没过——配置已写入，但先按上面的 ✗ 修好再重启 DSH\033[0m\n'
	fi
else
	step '6. 跳过自检（没提供密钥或加了 --no-verify）'
fi

# ---------- 7. 下一步 ----------
step '完成，下一步'
cat <<TIP
  1) 重启 DSH：
       systemctl list-units --type=service | grep -i dsh     # 找服务名
       sudo systemctl restart <那个服务>
     （不是服务的话，按你自己的方式重新拉起，比如重新执行 dsh web）

  2) 验证：在聊天里问「列一下 OCS 里的浏览器」
     工具名是 mcp__ocs__*；没出现就看 DSH 启动日志里 dsh-mcp-client 的报错。

  3) 通知（可选）：
       export DSH_BOT_ID='bot_…' DSH_TARGET_ID='tgt_…'
       node $BRIDGE_DIR/ocs-watch.mjs --loop --every 60 --deliver dsh

  回滚配置：cp '$BACKUP' '$PATCH'
TIP
