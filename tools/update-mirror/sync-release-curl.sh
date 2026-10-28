#!/usr/bin/env bash
#
# 无 gh 依赖的 Release 同步脚本：只用 curl + openssl，适合 VPS 上直接跑。
# 与 sync-release.sh 的区别：
#   - 不再要求 GitHub CLI / 登录，release 公开可直接下载；
#   - 不传 tag 时通过 GitHub API 取 latest；
#   - 下载后按 latest-linux.yml 里的 sha512 校验 AppImage；
#   - 同步完成后删除目录里其它旧版本的 AppImage / deb，避免磁盘越堆越大。
#
# 目录约定（平铺，electron-updater 按文件名相对 feed 根目录解析）：
#   /srv/ocs-dl/latest-linux.yml
#   /srv/ocs-dl/ocs-<version>-setup-linux-x86_64.AppImage
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
APP="$(sed -n 's/^path:[[:space:]]*//p' "$TMP/latest-linux.yml" | head -n1)"
[ -n "$APP" ] || APP="$(sed -n 's/^[[:space:]]*- url:[[:space:]]*//p' "$TMP/latest-linux.yml" | head -n1)"
WANT="$(sed -n 's/^sha512:[[:space:]]*//p' "$TMP/latest-linux.yml" | head -n1)"
[ -n "$VER" ] && [ -n "$APP" ] || {
	log 'latest-linux.yml 缺少 version / path'
	exit 1
}

DEB="ocs-${VER}-setup-linux-amd64.deb"

log "下载 $APP"
curl -fL --retry 5 --retry-delay 3 --connect-timeout 20 -C - -o "$TMP/$APP" "$BASE/$APP"
GOT="$(openssl dgst -sha512 -binary "$TMP/$APP" | base64 -w0)"
[ "$GOT" = "$WANT" ] || {
	log 'AppImage sha512 校验失败，放弃本次同步'
	exit 1
}
log 'AppImage 校验通过'

log "下载 $DEB"
curl -fL --retry 5 --retry-delay 3 --connect-timeout 20 -C - -o "$TMP/$DEB" "$BASE/$DEB"
curl -fL --retry 3 --connect-timeout 20 -o "$TMP/CHANGELOG.md" "$BASE/CHANGELOG.md" || log 'CHANGELOG.md 下载失败（忽略）'

install -m 0644 "$TMP/$APP" "$DIR/$APP"
install -m 0644 "$TMP/$DEB" "$DIR/$DEB"
[ -f "$TMP/CHANGELOG.md" ] && install -m 0644 "$TMP/CHANGELOG.md" "$DIR/CHANGELOG.md" || true
install -m 0644 "$TMP/latest-linux.yml" "$DIR/latest-linux.yml.new"
mv -f "$DIR/latest-linux.yml.new" "$DIR/latest-linux.yml"

find "$DIR" -maxdepth 1 -type f \( -name 'ocs-*.AppImage' -o -name 'ocs-*.deb' \) \
	! -name "$APP" ! -name "$DEB" -delete

log "完成：$TAG（version=$VER）"
ls -lh "$DIR" | sed '1d'
