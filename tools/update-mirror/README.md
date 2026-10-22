# 自建更新镜像（VPS）

GitHub Releases 在国内下载很慢。这个目录提供一套最小可用的自建更新源：

- VPS 上放安装包和一份 `latest.json`；
- OCS 设置页把更新源改成「自建镜像」，填入你的地址；
- 客户端先读清单，版本有更新时从你的 VPS 下载安装包；镜像不可用时自动回退 GitHub。

## 目录结构

```
/srv/ocs-dl/
├── latest.json
├── v2.13.18/
│   ├── ocs-2.13.18-setup-linux-amd64.deb
│   └── ocs-2.13.18-setup-linux-x86_64.AppImage
└── v2.13.17/
    └── ...
```

`latest.json`（客户端只认这一种结构；资源可以是相对路径）：

```json
{
  "tag": "v2.13.18",
  "body": "更新说明（可选）",
  "assets": {
    "linux": {
      "deb": "v2.13.18/ocs-2.13.18-setup-linux-amd64.deb",
      "appimage": "v2.13.18/ocs-2.13.18-setup-linux-x86_64.AppImage"
    }
  }
}
```

## 同步

在 VPS 上（需要 `gh` 已登录、`jq`）：

```bash
sudo bash sync-release.sh v2.13.18
```

脚本会下载该 Release 的产物到 `/srv/ocs-dl/<tag>/`，并重写 `latest.json`。
之后每次发版重复执行即可；想省事可以加一条 cron，每 30 分钟同步最新 Release：

```bash
*/30 * * * * /usr/local/bin/sync-release.sh "$(gh release view -R f1301065492/ocs-desktop-linux-build --json tagName -q .tagName)" >/dev/null 2>&1
```

如果 VPS 访问 GitHub 也不快，可以在能访问 GitHub 的机器上 `gh release download` 后 `scp` 过去，再手工生成 `latest.json`。

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

nginx 的静态文件默认支持 `Range`（断点续传），安装包 200MB+ 也能正常下载。

验证：

```bash
curl -I https://dl.example.com/ocs/latest.json
curl -I https://dl.example.com/ocs/v2.13.18/ocs-2.13.18-setup-linux-amd64.deb
```

## 客户端

设置 → 软件更新：

- 更新源选「自建镜像」；
- 镜像地址填 `https://dl.example.com/ocs`（不要带 `/latest.json`）；
- 保存后，下次检查更新生效（重启软件或等待下一次自动检查）。

行为说明：

- 镜像清单读取失败、或清单里没有适配当前平台的包时，会**自动回退 GitHub Releases**（日志里能看到）；
- AppImage 仍然是「下载后替换自身并重启」；deb 仍然是「下载后给出一条 `apt install` 命令」；
- 版本比较用清单里的 `tag`，写法 `v2.13.18` 或 `2.13.18` 都可以。

## 安全

- 用 HTTPS（正规证书），不要用自签名或 HTTP——更新包没有额外签名，传输层是唯一保障；
- `latest.json` 和安装包放在同一个可读目录即可，不需要鉴权；
- 保留最近一两个版本，旧版本目录可以定期清理。
