# 自建更新镜像（VPS）

GitHub Releases 在国内下载很慢。这个目录提供一套最小可用的自建更新源，
配合 OCS 设置页的「软件更新 → 自建镜像」使用。

> 3.x 起更新由 **electron-updater**（generic provider）负责：镜像根目录必须提供
> `latest-linux.yml`（Windows 为 `latest.yml`）以及清单里引用的安装包。

## 目录结构

```
/srv/ocs-dl/
├── latest-linux.yml
├── ocs-2.13.25-setup-linux-x86_64.AppImage
├── ocs-2.13.25-setup-linux-amd64.deb
└── v2.13.25/                      # 按 tag 归档的原始产物（可选保留）
    └── ...
```

`latest-linux.yml` 由 electron-builder 在打包时生成，清单里的 `path` / `files[].url`
是**相对 feed 根目录**的文件名，所以安装包必须与它放在同一层。

## 同步

**方式一：curl（VPS 上没有 gh 时用这个，推荐）**

```bash
sudo bash sync-release-curl.sh              # 同步最新 release
sudo bash sync-release-curl.sh v3.6.0.1     # 或指定 tag
```

脚本会下载 `latest-linux.yml`、AppImage、deb、`CHANGELOG.md`，按清单里的 sha512 校验
AppImage，原子替换根目录文件，并删除旧版本的安装包。版本未变且文件齐全时直接跳过，
不会重复下载。当前 VPS 上安装在 `/usr/local/bin/ocs-sync-release.sh`，由
`/etc/cron.d/ocs-update-sync` 每天 04:17 兜底执行，日志写到 `/var/log/ocs-update-sync.log`。

**发版后立即同步（不等定时）**：`.github/workflows/release.yml` 在构建发布完成后调用
`sync-mirror.yml`，通过 SSH 执行上面的脚本。需要的仓库 Secrets：

| Secret | 说明 |
| --- | --- |
| `VPS_SYNC_SSH_KEY` | 专用 ed25519 私钥；VPS `authorized_keys` 里限制为只能执行同步脚本 |
| `VPS_SYNC_HOST` / `VPS_SYNC_PORT` / `VPS_SYNC_USER` | VPS 地址、SSH 端口、登录用户 |

手动补同步：`gh workflow run sync-mirror.yml`。定时任务保留作兜底（例如 Actions 失败）。

**方式二：gh（本机已登录 GitHub CLI 时）**

```bash
sudo bash sync-release.sh v2.13.25
```

脚本会：

1. 下载该 Release 的全部产物到 `/srv/ocs-dl/<tag>/`；
2. 把 `latest-linux.yml` 与安装包复制到 `/srv/ocs-dl/` 根目录（覆盖上一版）；
3. 修正目录所有者。

每次发版重复执行即可；想省事可以加 cron，每 30 分钟同步最新 Release：

```bash
*/30 * * * * /usr/local/bin/sync-release.sh "$(gh release view -R f1301065492/ocs-desktop-linux-build --json tagName -q .tagName)" >/dev/null 2>&1
```

如果 VPS 访问 GitHub 也不快，可以在能访问 GitHub 的机器上 `gh release download` 后
`scp` 过去，再手工把 `latest-linux.yml` 和安装包放到根目录。

## Docker 部署（当前 VPS 的方式）

用官方 `nginx:alpine` 容器只读挂载 `/srv/ocs-dl`，只监听回环，反向代理由面板/宿主机 nginx 负责：

```bash
mkdir -p /srv/ocs-dl
docker pull nginx:alpine
docker run -d --name ocs-update --restart unless-stopped \
  -p 127.0.0.1:15321:80 \
  -v /srv/ocs-dl:/usr/share/nginx/html:ro \
  nginx:alpine
```

验证：

```bash
curl -sI http://127.0.0.1:15321/latest-linux.yml
curl -s -o /dev/null -w '%{http_code}\n' -r 0-1023 \
  http://127.0.0.1:15321/ocs-3.6.0-1-setup-linux-x86_64.AppImage   # 期望 206
```

容器只绑 `127.0.0.1`，外部访问必须经过宿主机反向代理（宝塔站点 → 反向代理 →
目标 `http://127.0.0.1:15321`）。若反代挂在子路径 `/ocs/`，`proxy_pass` 末尾要带 `/`
以去掉前缀，保证客户端请求的 `/ocs/latest-linux.yml` 落到容器的 `/latest-linux.yml`。
nginx 静态文件原生支持 `Range`，AppImage 断点续传正常。

```bash
# 更新镜像内容后无需重启容器（只读挂载目录实时生效）
docker logs --tail 20 ocs-update      # 看访问日志
```

## nginx

假设域名 `dl.example.com` 已配好证书（Let's Encrypt 即可）：

```nginx
server {
    listen 443 ssl http2;
    server_name dl.example.com;

    ssl_certificate     /etc/letsencrypt/live/dl.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dl.example.com/privkey.pem;

    location /ocs/ {
        alias /srv/ocs-dl/;
        autoindex off;
        sendfile on;
        tcp_nopush on;
        add_header Cache-Control "public, max-age=300";
    }
}
```

nginx 的静态文件默认支持 `Range`（断点续传）。

验证：

```bash
curl -I https://dl.example.com/ocs/latest-linux.yml
curl -I https://dl.example.com/ocs/ocs-2.13.25-setup-linux-x86_64.AppImage
```

## 客户端

设置 → 软件更新：

- 更新源选「自建镜像」；
- 镜像地址填 `https://dl.example.com/ocs`（不要带 `/latest-linux.yml`）；
- 保存后，下次检查更新生效（重启软件或等待下一次自动检查）。

行为说明：

- 镜像不可用或缺少清单时，electron-updater 会记录错误并视为「暂无更新」；
  需要恢复官方源时，把更新源切回「GitHub 官方」即可。
- **AppImage** 支持应用内自动更新（下载后替换并重启）。
- **deb** 安装的用户建议继续用 `apt` 或手动下载安装包；electron-updater 在 Linux 上
  只对 AppImage 做应用内更新。

## 安全

- 用 HTTPS（正规证书），不要用自签名或 HTTP——传输层是唯一保障；
- `latest-linux.yml` 和安装包放在同一个可读目录即可，不需要鉴权；
- 保留最近一两个版本，旧版本目录可以定期清理。
