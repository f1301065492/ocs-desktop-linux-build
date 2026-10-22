#!/usr/bin/env bash
#
# 在 VPS 上把某个 Release 的安装包同步到本地目录，并生成 latest.json。
#
# 目录约定：
#   /srv/ocs-dl/latest.json
#   /srv/ocs-dl/v2.13.18/ocs-2.13.18-setup-linux-amd64.deb
#   /srv/ocs-dl/v2.13.18/ocs-2.13.18-setup-linux-x86_64.AppImage
#
# 用法：
#   sudo bash sync-release.sh v2.13.18
#   环境变量：REPO / DL_DIR / OWNER
#
# 依赖：GitHub CLI（gh），且已 `gh auth login`；VPS 访问 GitHub 通常比国内快，
#       这也是把镜像放在 VPS 上的意义。
#
set -euo pipefail

TAG="${1:?用法: sync-release.sh <tag>，例如 v2.13.18}"
REPO="${REPO:-f1301065492/ocs-desktop-linux-build}"
DIR="${DL_DIR:-/srv/ocs-dl}"
OWNER="${OWNER:-www}"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || fail '需要 GitHub CLI（gh）。也可以手动把安装包放进 $DIR/$TAG'
command -v jq >/dev/null 2>&1 || fail '需要 jq（生成清单用）'

step "1. 下载 $TAG"
mkdir -p "$DIR/$TAG"
gh release download "$TAG" -R "$REPO" -D "$DIR/$TAG" --clobber
info "文件：$(ls -1 "$DIR/$TAG" | tr '\n' ' ')"

DEB="$(basename "$(ls "$DIR/$TAG"/*.deb 2>/dev/null | head -n1 || true)")"
APPIMAGE="$(basename "$(ls "$DIR/$TAG"/*.AppImage 2>/dev/null | head -n1 || true)")"
[ -n "$DEB" ] || [ -n "$APPIMAGE" ] || fail "$TAG 里没有 .deb / .AppImage"

step '2. 生成 latest.json'
BODY="$(gh release view "$TAG" -R "$REPO" --json body -q .body 2>/dev/null || true)"
export TAG DEB APPIMAGE BODY
jq -n '{
  tag: env.TAG,
  body: (env.BODY // ""),
  assets: {
    linux: (
      {}
      + (if env.DEB != "" then { deb: (env.TAG + "/" + env.DEB) } else {} end)
      + (if env.APPIMAGE != "" then { appimage: (env.TAG + "/" + env.APPIMAGE) } else {} end)
    )
  }
}' > "$DIR/latest.json"
info "已写入 $DIR/latest.json"

step '3. 权限'
chown -R "$OWNER":"$OWNER" "$DIR" 2>/dev/null || true
info "所有者：$OWNER"

cat <<TIP

客户端设置：设置 → 软件更新 → 自建镜像 → 填 https://你的域名/ocs
（服务器目录需通过 nginx 暴露在 /ocs/ 下，见 README.md）
TIP
