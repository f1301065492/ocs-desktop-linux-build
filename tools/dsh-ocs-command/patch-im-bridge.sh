#!/usr/bin/env bash
#
# 让 DSH 的飞书机器人也能使用 /ocs 命令（本地执行，不经过模型）。
#
# DSH 的 IM 桥接只识别内置命令（/new /compact /status …），未知的 `/xxx`
# 会当作普通提问发给模型。这里在飞书桥接的消息处理里插入一段拦截：
# 遇到 `/ocs ...` 就调用 Harness 的命令网关执行，并把结果直接回复到聊天。
#
# 注意：这是**对第三方插件源码的补丁**。插件升级后会被覆盖，重新执行本脚本即可。
# 脚本带备份，`--revert` 可恢复最近一次备份。
#
# 用法：
#   sudo bash patch-im-bridge.sh [--profile web] [--dsh-home /root/.dsh]
#   sudo bash patch-im-bridge.sh --revert
#
set -euo pipefail

MARK_START='// >>> ocs-im (managed by patch-im-bridge.sh) >>>'
MARK_END='// <<< ocs-im <<<'
ANCHOR="    if (commandText === '/compact') {"

DSH_HOME="${DSH_HOME:-/root/.dsh}"
PROFILE='web'
CHANNEL='feishu'
REVERT=0

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--profile) PROFILE="$2"; shift 2 ;;
		--dsh-home) DSH_HOME="$2"; shift 2 ;;
		--channel) CHANNEL="$2"; shift 2 ;;
		--revert) REVERT=1; shift ;;
		-h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) fail "未知参数：$1" ;;
	esac
done

[ "$CHANNEL" = 'feishu' ] || fail "目前只支持飞书渠道（--channel feishu）；企微桥接的命令分发结构不同，需要单独适配"

if [ -d "$DSH_HOME/.dsh/profiles" ]; then
	DSH_HOME="$DSH_HOME/.dsh"
fi
[ -d "$DSH_HOME/profiles/$PROFILE" ] || fail "找不到 profile：$DSH_HOME/profiles/$PROFILE"

FILE="$DSH_HOME/profiles/$PROFILE/node_modules/@xmanrui/dsh-im/src/channels/feishu/bridge.mjs"
[ -f "$FILE" ] || fail "找不到飞书桥接文件：$FILE（先确认 IM 插件已安装）"

if [ "$REVERT" = 1 ]; then
	BACKUP="$(ls -1t "$FILE".bak-* 2>/dev/null | head -n 1 || true)"
	[ -n "$BACKUP" ] || fail '没有找到备份文件'
	cp "$BACKUP" "$FILE"
	info "已恢复：$BACKUP -> $FILE"
	exit 0
fi

step '1. 备份并检查锚点'
BACKUP="$FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp "$FILE" "$BACKUP"
info "备份：$BACKUP"
grep -qF "$ANCHOR" "$FILE" || fail "找不到插入锚点（/compact 分支），插件版本可能已变化"

step '2. 写入拦截代码'
BLOCK="$(mktemp)"
cat > "$BLOCK" <<'JS'
    // >>> ocs-im (managed by patch-im-bridge.sh) >>>
    if (/^\/ocs(?:\s|$)/i.test(commandText)) {
      const ocsSessionId = typeof this.#state?.sessionFor === 'function' ? this.#state.sessionFor(key) : null;
      if (typeof ocsSessionId !== 'string' || !ocsSessionId) {
        await this.#send(event.message.chat_id, '当前聊天还没有会话，请先发送一条普通消息再使用 /ocs。', { replyTo: event.message.message_id });
        return;
      }
      try {
        let ocsExecution;
        if (typeof this.#harness?.workspaceSession === 'function') {
          const ocsSession = this.#harness.workspaceSession(ocsSessionId, key);
          ocsExecution = typeof ocsSession?.executeCommand === 'function'
            ? await ocsSession.executeCommand(commandText.trim(), { signal: this.#signal })
            : undefined;
        } else if (typeof this.#harness?.executeCommand === 'function') {
          ocsExecution = await this.#harness.executeCommand(ocsSessionId, commandText.trim(), { signal: this.#signal });
        }
        if (!ocsExecution) {
          await this.#send(event.message.chat_id, '当前 Harness 不支持从机器人执行命令。', { replyTo: event.message.message_id });
          return;
        }
        const ocsResult = ocsExecution.result;
        const ocsText = (ocsResult && ocsResult.text)
          || (ocsResult && ocsResult.kind === 'error' ? '命令执行失败' : '命令已执行');
        await this.#send(event.message.chat_id, ocsText, { replyTo: event.message.message_id });
      } catch (err) {
        await this.#send(event.message.chat_id, `执行 /ocs 失败：${err?.message || String(err)}`, { replyTo: event.message.message_id });
      }
      return;
    }
    // <<< ocs-im <<<
JS

TMP="$(mktemp)"
awk -v e="$MARK_END" -v anchor="$ANCHOR" -v blockfile="$BLOCK" '
	/^[ \t]*\/\/ >>> ocs-im \(managed by patch-im-bridge\.sh\) >>>/ { skip=1; next }
	/^[ \t]*\/\/ <<< ocs-im <<</ { skip=0; next }
	skip == 1 { next }
	{
		if (!done && $0 == anchor) {
			while ((getline line < blockfile) > 0) print line
			close(blockfile)
			done = 1
		}
		print
	}
' "$FILE" > "$TMP"
mv "$TMP" "$FILE"
rm -f "$BLOCK"

step '3. 校验'
COUNT="$(grep -c '>>> ocs-im (managed by patch-im-bridge.sh) >>>' "$FILE" || true)"
info "受管块数量：$COUNT"
[ "$COUNT" = '1' ] || { cp "$BACKUP" "$FILE"; fail '补丁插入数量异常，已自动回滚'; }
if command -v node >/dev/null 2>&1; then
	node --check "$FILE" && info '语法检查通过'
else
	info '（没有 node，跳过语法检查）'
fi

step '4. 下一步'
cat <<TIP
  重启 DSH 后，在飞书私聊里发送：

      /ocs 帮助

  命令名固定 /ocs（DSH 只允许小写 ASCII），子指令支持中文。
  撤销补丁：sudo bash $0 --revert
TIP
