#!/usr/bin/env bash
#
# 把 /ocs 命令插件装进 DSH 的 web profile（本地执行、不经过模型）。
#
# 做的事：
#   1. 把 index.js / package.json 复制到 <DSH_HOME>/profiles/<profile>/node_modules/ocs-command
#   2. 在 profile 的 cordis.patch.yml 里写入/更新一段带标记的插件配置（先备份）
#   3. 提示重启 DSH
#
# 用法：
#   sudo bash install.sh --base https://127.0.0.1:15320 \
#        --key '远程 API 密钥' --fingerprint 'AB:CD:…' [--profile web] [--dsh-home /root/.dsh]
#
set -euo pipefail

MARK_START='# >>> ocs-command (managed by install.sh) >>>'
MARK_END='# <<< ocs-command <<<'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-/root/.dsh}"
PROFILE='web'
BASE='https://127.0.0.1:15320'
KEY=''
FP=''

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--profile) PROFILE="$2"; shift 2 ;;
		--dsh-home) DSH_HOME="$2"; shift 2 ;;
		--base) BASE="$2"; shift 2 ;;
		--key) KEY="$2"; shift 2 ;;
		--fingerprint) FP="$2"; shift 2 ;;
		-h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) fail "未知参数：$1" ;;
	esac
done

[ -f "$SCRIPT_DIR/index.js" ] || fail "找不到 index.js（请在插件目录里运行）"
[ -f "$SCRIPT_DIR/package.json" ] || fail "找不到 package.json"

# 兼容 <dir>/.dsh/profiles 与 <dir>/profiles 两种布局
if [ -d "$DSH_HOME/.dsh/profiles" ]; then
	DSH_HOME="$DSH_HOME/.dsh"
fi
[ -d "$DSH_HOME/profiles/$PROFILE" ] || fail "找不到 profile：$DSH_HOME/profiles/$PROFILE"

if [ -z "$KEY" ]; then
	printf '  粘贴 OCS 远程 API 密钥（输入不回显）：'
	read -rsp '' KEY || true
	printf '\n'
fi
[ -n "$KEY" ] || fail '缺少 --key（OCS 设置 → 远程 API 里生成的那串）'

DEST="$DSH_HOME/profiles/$PROFILE/node_modules/ocs-command"
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
[ -f "$PATCH" ] || fail "找不到 $PATCH"

step '1. 安装插件文件'
mkdir -p "$DEST"
cp "$SCRIPT_DIR/index.js" "$SCRIPT_DIR/package.json" "$DEST/"
info "已复制到 $DEST"

step '2. 写入插件配置'
BACKUP="$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
cp "$PATCH" "$BACKUP"
info "已备份：$BACKUP"

yaml_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

TMP="$(mktemp)"
awk -v e="$MARK_END" '
	$0 ~ /^# >>> ocs-command .*>>>$/ { skip=1; next }
	$0 == e { skip=0; next }
	skip != 1 { print }
' "$PATCH" > "$TMP"

cat >> "$TMP" <<YAML

$MARK_START
- insert:
    - id: ocs-command
      name: ocs-command
      config:
        base: $(yaml_quote "$BASE")
        apiKey: $(yaml_quote "$KEY")
        certFingerprint: $(yaml_quote "$FP")
$MARK_END
YAML

mv "$TMP" "$PATCH"
chmod 600 "$PATCH" 2>/dev/null || true
info "已写入：$PATCH"
grep -nE "^# >>> ocs-command|id: ocs-command|base:" "$PATCH" | sed 's/^/    /'

step '3. 下一步'
cat <<TIP
  重启 DSH（面板/PM2 或你原来的方式），然后在聊天里输入：

      /ocs 帮助

  命令名固定为 /ocs（DSH 只允许小写 ASCII），子指令和参数支持中文。
TIP
