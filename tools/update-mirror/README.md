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

在 VPS 上（需要 `gh` 已登录）：

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
