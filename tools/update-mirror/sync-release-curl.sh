#!/usr/bin/env bash
#
# 无 gh 依赖的 Release 同步脚本：只用 curl + openssl，适合 VPS 上直接跑。
# 与 sync-release.sh 的区别：
#   - 不再要求 GitHub CLI / 登录，release 公开可直接下载；
#   - 不传 tag 时通过 GitHub API 取 latest；
#   - 下载后按 latest-linux.yml 里的 sha512 校验 deb；
#   - 同步完成后删除目录里其它旧版本 deb（以及历史遗留 AppImage），避免磁盘越堆越大。
#
# 目录约定（平铺，electron-updater 按文件名相对 feed 根目录解析）：
#   /srv/ocs-dl/latest-linux.yml
#   /srv/ocs-dl/ocs-<version>-setup-linux-amd64.deb
#   /srv/ocs-dl/CHANGELOG.md            # 更新弹窗用
#
# 用法：
#   bash sync-release-curl.sh              # 同步最新 release
#   bash sync-release-curl.sh v3.6.0.1     # 同步指定 tag
#   环境变量：REPO / DL_DIR
#
set -euo pipefail

REPO="${REPO:-f1301065492/ocs-desktop-linux-build}"
DIR="${DL_DIR:-/srv/ocs-dl}"
TAG="${1:-}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

if [ -z "$TAG" ]; then
	TAG="$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' \
		"https://api.github.com/repos/$REPO/releases/latest" |
		sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -n "$TAG" ] || {
	log '无法获取最新 release tag'
	exit 1
}

BASE="https://github.com/$REPO/releases/download/$TAG"
mkdir -p "$DIR"
TMP="$(mktemp -d "$DIR/.sync-$TAG.XXXXXX")"
cleanup() {
	find "$TMP" -mindepth 1 -delete 2>/dev/null || true
	rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

log "开始同步 $TAG"
curl -fL --retry 5 --retry-delay 3 --connect-timeout 20 -o "$TMP/latest-linux.yml" "$BASE/latest-linux.yml"

VER="$(sed -n 's/^version:[[:space:]]*//p' "$TMP/latest-linux.yml" | head -n1)"
PACKAGE="$(sed -n 's/^path:[[:space:]]*//p' "$TMP/latest-linux.yml" | head -n1)"
[ -n "$PACKAGE" ] || PACKAGE="$(sed -n 's/^[[:space:]]*- url:[[:space:]]*//p' "$TMP/latest-linux.yml" | head -n1)"
WANT="$(sed -n 's/^sha512:[[:space:]]*//p' "$TMP/latest-linux.yml" | head -n1)"
[ -n "$VER" ] || {
	log 'latest-linux.yml 缺少 version'
	exit 1
}

# 2026-10-29 起 Linux 只发布 deb；清单里 path 应指向 deb。
# 兼容旧清单（path 是 AppImage）时按版本号推导 deb 文件名。
case "$PACKAGE" in
	*.deb) DEB="$PACKAGE" ;;
	*) DEB="ocs-${VER}-setup-linux-amd64.deb" ;;
esac

# 版本没变且文件齐全时直接退出：定时任务/发版触发都会频繁调用，避免重复拉 300MB+
LOCAL_VER="$(sed -n 's/^version:[[:space:]]*//p' "$DIR/latest-linux.yml" 2>/dev/null | head -n1 || true)"
if [ "${FORCE:-0}" != "1" ] && [ "$LOCAL_VER" = "$VER" ] && [ -f "$DIR/$DEB" ]; then
	log "已是最新 $VER，跳过下载"
	exit 0
fi

log "下载 $DEB"
curl -fL --retry 5 --retry-delay 3 --connect-timeout 20 -C - -o "$TMP/$DEB" "$BASE/$DEB"
if [ -n "$WANT" ]; then
	GOT="$(openssl dgst -sha512 -binary "$TMP/$DEB" | base64 -w0)"
	[ "$GOT" = "$WANT" ] || {
		log 'deb sha512 校验失败，放弃本次同步'
		exit 1
	}
	log 'deb 校验通过'
fi

curl -fL --retry 3 --connect-timeout 20 -o "$TMP/CHANGELOG.md" "$BASE/CHANGELOG.md" || log 'CHANGELOG.md 下载失败（忽略）'

install -m 0644 "$TMP/$DEB" "$DIR/$DEB"
[ -f "$TMP/CHANGELOG.md" ] && install -m 0644 "$TMP/CHANGELOG.md" "$DIR/CHANGELOG.md" || true
install -m 0644 "$TMP/latest-linux.yml" "$DIR/latest-linux.yml.new"
mv -f "$DIR/latest-linux.yml.new" "$DIR/latest-linux.yml"

# 清理旧版本包，并顺手删掉历史遗留的 AppImage（不再发布）
find "$DIR" -maxdepth 1 -type f \( -name 'ocs-*.deb' -o -name 'ocs-*.AppImage' \) 	! -name "$DEB" -delete

log "完成：$TAG（version=$VER）"
ls -lh "$DIR" | sed '1d'
