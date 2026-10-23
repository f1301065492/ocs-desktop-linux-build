#!/usr/bin/env bash
#
# 在 VPS 上把某个 Release 同步到本地目录，供 electron-updater 的 generic 源使用。
#
# 目录约定（平铺，electron-updater 按文件名相对 feed 根目录解析）：
#   /srv/ocs-dl/latest-linux.yml
#   /srv/ocs-dl/ocs-<version>-setup-linux-x86_64.AppImage
#   /srv/ocs-dl/ocs-<version>-setup-linux-amd64.deb
#   /srv/ocs-dl/<tag>/...                # 保留一份按 tag 归档的原始文件
#
# 用法：
#   sudo bash sync-release.sh v2.13.25
#   环境变量：REPO / DL_DIR / OWNER
#
# 依赖：GitHub CLI（gh），且已 `gh auth login`。
#
set -euo pipefail

TAG="${1:?用法: sync-release.sh <tag>，例如 v2.13.25}"
REPO="${REPO:-f1301065492/ocs-desktop-linux-build}"
DIR="${DL_DIR:-/srv/ocs-dl}"
OWNER="${OWNER:-www}"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || fail '需要 GitHub CLI（gh）。也可以手动把安装包与 latest-linux.yml 放进 $DIR'

step "1. 下载 $TAG"
mkdir -p "$DIR/$TAG"
gh release download "$TAG" -R "$REPO" -D "$DIR/$TAG" --clobber
info "文件：$(ls -1 "$DIR/$TAG" | tr '\n' ' ')"

[ -f "$DIR/$TAG/latest-linux.yml" ] || fail "$TAG 缺少 latest-linux.yml：请确认发布产物包含它（见 build-linux-appimage.yml）"

step '2. 同步到 feed 根目录'
# 清单里的 url 是文件名（不含 tag 目录），所以安装包必须与 yml 同目录
cp -f "$DIR/$TAG"/*.AppImage "$DIR/" 2>/dev/null || true
cp -f "$DIR/$TAG"/*.deb "$DIR/" 2>/dev/null || true
cp -f "$DIR/$TAG"/latest-linux.yml "$DIR/latest-linux.yml"
info "已同步：$(ls -1 "$DIR"/latest-linux.yml "$DIR"/*.AppImage "$DIR"/*.deb 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"

step '3. 权限'
chown -R "$OWNER":"$OWNER" "$DIR" 2>/dev/null || true
info "所有者：$OWNER"

cat <<TIP

客户端设置：设置 → 软件更新 → 自建镜像 → 填 https://你的域名/ocs
（服务器目录需通过 nginx 暴露在 /ocs/ 下，见 README.md）
TIP
