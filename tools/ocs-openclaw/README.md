# OCS × 聊天运行时（OpenClaw / DSH）× 飞书

用**飞书对话**看住 OCS：能问"现在几台在跑""截个图看看"，也能让 OCS **主动推送**——登录成功、需要人工输验证码、浏览器掉线，直接弹到飞书。

> 这套东西**与聊天运行时无关**：`ocs-mcp-server.mjs` 是标准 MCP（stdio），
> OpenClaw 和 DSH（DeepSeek Harness）都能挂；`ocs-watch.mjs` 是普通脚本，谁调度都行。
> 下面第二节讲 OpenClaw，第三节讲 DSH。

## 拓扑

**当前部署：DSH 与 OCS 同机**（见第七节；下面同时保留两台机器的形态，方便以后拆开）。

```
同一台机器（Linux）
  OCS Desktop ── 远程 API  https://127.0.0.1:15320      ← 同机走回环，不开端口、不过网络
        ▲
        │ 本机 HTTPS + X-API-Key（建议按证书指纹固定）
        ▼
  DSH（DeepSeek Harness）
  ├─ @deepseek-ai/dsh-mcp-client(stdio) → ocs-mcp-server.mjs   工具：mcp__ocs__*
  ├─ 定时/常驻任务                       → ocs-watch.mjs → 通知投递
  └─ IM 插件（@xmanrui/dsh-im）          → 飞书/微信/钉钉…（长连接，不需要公网回调）
        ▲
        │ POST http://127.0.0.1:3080/api/dsh-im/delivery/messages（不经过模型，零 token）
        └── ocs-watch.mjs --deliver dsh

拆分（两台机器）时：把 127.0.0.1 换成对方的局域网 IP，OCS 远程 API 改绑 0.0.0.0 并放行 15320。
```

四个脚本都是**零依赖**的 Node（用 `node:` 内置模块），拷过去就能跑，不用 `npm install`。

| 文件 | 作用 |
| --- | --- |
| `ocs-client.mjs` | OCS 远程 API 的最小客户端（证书指纹固定、错误码透传），被其它几个复用 |
| `ocs-mcp-server.mjs` | MCP（stdio）服务，给 agent 用：`ocs_*` 系列工具（OpenClaw 里显示为 `mcp_ocs_*`，DSH 里是 `mcp__ocs__*`） |
| `ocs-watch.mjs` | 轮询日志与状态，发现有价值的新内容就把要推送的文本打到 stdout |
| `check-ocs.mjs` | **连接自检**：连通性、密钥、证书指纹、渲染进程、日志接口逐项检查，失败项直接给"该去哪改" |
| `test/` | 本机自测：假 OCS（HTTPS + 自签证书）+ 断言，不依赖真机 |

> 需要 OCS **≥ 2.13.6**：`ocs_logs` / `ocs-watch` 依赖那个版本才有的日志接口。

## 一、机器 A（OCS 侧）

1. OCS → 设置 → 远程 API：**开启**，监听地址选 `0.0.0.0`，端口默认 `15320`；**生成一次密钥并复制**（明文只显示一次）。
2. 放行防火墙入站 TCP 15320（只在内网开放即可）：
   ```powershell
   New-NetFirewallRule -DisplayName "OCS Remote API" -Direction Inbound -Protocol TCP -LocalPort 15320 -Action Allow -Profile Private
   ```
3. 在机器 B 上验证连通、并记下**证书指纹**：
   ```bash
   curl -k https://<机器A的IP>:15320/api/v1/health
   # 关注 certFingerprint（形如 AB:CD:...）与 rendererReady 是否为 true
   ```

OCS 侧不需要再改任何东西——`/logs`、`/screenshot`、`/pages`、启动/关闭都是现成接口。

## 二、机器 B（OpenClaw 侧）

### 1. 放脚本 + 凭证

把本目录拷到机器 B，然后在 **`~/.openclaw/.env`** 里放凭证（这样配置文件里不用写明文）：

```
OCS_BASE=https://192.168.1.30:15320
OCS_API_KEY=在机器A生成的那串
OCS_CERT_SHA256=AB:CD:EF:...
```

> `OCS_CERT_SHA256` 强烈建议填。不填时脚本会**不校验**自签证书（会在 stderr 提醒一次）——
> 同网段的中间人那样就能拿到你的 API 密钥。

### 2. 挂 MCP 工具（对话控制）

`~/.openclaw/openclaw.json`：

```json
{
  "mcp": {
    "servers": {
      "ocs": {
        "command": "node",
        "args": ["/绝对路径/ocs-mcp-server.mjs"],
        "env": {
          "OCS_BASE": "${OCS_BASE}",
          "OCS_API_KEY": "${OCS_API_KEY}",
          "OCS_CERT_SHA256": "${OCS_CERT_SHA256}"
        }
      }
    }
  }
}
```

重启网关后校验：

```bash
openclaw mcp list           # 应能看到 ocs
openclaw mcp status ocs
```

工具会以 `mcp_ocs_*` 的名字出现在 agent 的工具表里。启动浏览器这种耗时动作，默认只回 `taskId`，
想等一会儿就传 `waitSeconds`（建议 ≤20，避免超过 MCP 的请求超时；要等更久就把
`requestTimeoutMs` 调大，或让 agent 用 `ocs_task` 轮询）。

### 3. 接飞书（长连接，不用公网回调）

1. 飞书开放平台 → 建「企业自建应用」→ 开启**机器人**能力 → 权限至少 `im:message`、`im:message.p2p_msg`、`im:message:send_as_bot`、`im:resource`。
2. 事件订阅：加 `im.message.receive_v1`，订阅方式选**长连接**。
   ⚠️ 顺序：先在 OpenClaw 里配好飞书通道并让网关跑起来，**再**去后台把订阅方式切成「长连接」，否则保存会失败。
3. 版本管理里发布（内部发布即可）。

`~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "feishu": { "enabled": true, "appId": "${FEISHU_APP_ID}", "appSecret": "${FEISHU_APP_SECRET}" }
  },
  "plugins": {
    "entries": { "openclaw-feishu": { "enabled": true } }
  }
}
```

```bash
openclaw gateway restart
openclaw status                        # 期望看到 Feishu │ ON │ OK
openclaw channels status feishu
```

> 飞书插件有多个实现（`@openclaw/feishu`、`openclaw-feishu` 等），包名与字段名略有差异；
> 具体以你装的那个插件的文档为准。通道默认就是 websocket 长连接，不需要公网 IP / 域名 / 证书。

### 4. 配主动推送（这是"信息推送"的关键）

`ocs-watch.mjs` 只在**有新内容**时打印要播报的文本（没内容时打印 `HEARTBEAT_OK`，OpenClaw 会跳过）。
用 `--command` 挂成定时任务，输出会被 announce 到飞书：

```bash
openclaw cron add \
  --name "OCS 事件提醒" \
  --cron "*/3 * * * *" \
  --session isolated \
  --command "node /绝对路径/ocs-watch.mjs --once --state /var/lib/ocs-watch-state.json" \
  --announce --channel feishu --to "<飞书里的会话标识>"
```

- `--to` 的取值按飞书插件文档（通常是 chat id）。**先验证通道能不能发**：临时建一个
  `--message "ping" --announce --channel feishu --to ...` 的任务，跑通再换成 `--command`。
- 立刻试一次：`openclaw cron run <job-id>`，然后 `openclaw cron runs --id <job-id>` 看结果。
- 想少打扰：把 `--cron` 放到 `*/5` 或 `*/10`；想只看某台：`--uid <浏览器uid>`；
  想连普通日志也报：`--all`；想调关键字：`OCS_WATCH_PATTERNS='登录成功|需要人工|错误'`。

推送的样例长这样：

```
【OCS 提醒】
未命名浏览器 (1) [08ab9688]
  · 智慧树：检测到验证码，需要人工处理
未命名浏览器 [b4664404] 状态：launched → closed
```

## 三、DSH（DeepSeek Harness）接入

DSH 用**内置的 MCP 客户端**接 stdio server，一段配置就够，不需要额外装网关。

### 1. 先在 DSH 那台机器上自检（强烈建议）

```bash
export OCS_BASE=https://192.168.1.30:15320
export OCS_API_KEY='……'
export OCS_CERT_SHA256='AB:CD:……'
node check-ocs.mjs --uid <某个浏览器uid>
```

全绿再往下走。它会逐项告诉你：连不连得上、密钥对不对、证书指纹对不对、渲染进程是否就绪、
日志接口是否可用；红的每一项都带"该去哪改"的提示。**把网络/凭据问题和 DSH 配置问题分开查**，能省很多时间。

### 2. 配 MCP（用内置客户端，不需要额外装插件）

`@deepseek-ai/dsh-mcp-client` 是 DSH **自带的** MCP 客户端（桌面版就打包在 `app.asar` 里，已核实），
只需在 patch 层写一条 `insert:`。桌面 App 用 `$DSH_HOME/profiles/desktop/cordis.patch.yml`，
`dsh web` 用 `profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: ocs-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ocs
        transport: stdio
        command: node
        args: ['/绝对路径/tools/ocs-openclaw/ocs-mcp-server.mjs']
        cwd: '/绝对路径/tools/ocs-openclaw'
        env:
          OCS_BASE: 'https://192.168.1.30:15320'
          OCS_API_KEY: '在机器 A 生成的那串'
          OCS_CERT_SHA256: 'AB:CD:……'
        toolCallTimeoutMs: 30000
        failOnStartupError: false
```

几个必须注意的点：

- `serverName` 只能是 `[A-Za-z0-9_-]{1,32}`，且会进工具名：`mcp__ocs__ocs_list_browsers`。
- **路径一律写绝对路径**。
- **密钥写进 `config.env`**：DSH 启动子进程前会剔除"看起来像凭据"的环境变量，光在外面 `export` 传不进去。
- `failOnStartupError` 默认就是 `false`：OCS 暂时不可达时 DSH 照常启动，**工具照样注册**，调用时才报错
  （报错信息会直接告诉你连不上/密钥不对）。
- **没装 Node 怎么办**：DSH 桌面版自带的是 Electron。可以把 `command` 指向任意一个 Electron 可执行文件，
  并在 `env` 里加 `ELECTRON_RUN_AS_NODE: "1"`，它就会以 Node 22 运行这个 .mjs
  （本机就是这么配的；装好 Node 22 之后换回 `command: node` 更清爽）。
- 初始化握手失败时 harness 仍会启动，但该服务器的工具不出现，并记一条错误——
  遇到这种情况先用 `check-ocs.mjs` 排除 OCS 侧问题。

> 参考：官方模板就在 DSH 安装包里的
> `app.asar: dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml`。

改完重启（`dsh web` 或重开桌面 App）。工具可能要到下一轮对话才注册出来。

### 3. 验证

直接问 agent「列一下 OCS 里的浏览器」，或者让它调 `mcp__ocs__ocs_list_browsers`；
再试 `mcp__ocs__ocs_logs`（传 uid）——能看到脚本安装、登录事件、报错这些（账号密码已被脱敏）。

### 4. 其他接法（不想手改 YAML 的话）

- `dsh plugin --profile web add dsh-mcp-center` → Settings → MCP Center → 填 name/command/args/env/cwd；
- `dsh plugin --profile web add dsh-mcp-json-adapter` → 用标准 `.mcp.json`（`~/.agents/.mcp.json` 或项目根的 `.mcp.json`），
  形状就是常见的 `{"mcpServers": {"ocs": {"command": ..., "args": [...], "env": {...}}}}`。

> 提醒：DSH 插件是以**你的权限**运行的第三方代码，不做沙箱。装之前看一眼仓库活跃度，能固定版本就固定。

## 四、安全须知

- **密钥只放在机器 B**（OpenClaw 写 `~/.openclaw/.env`；DSH 写 `cordis.patch.yml` 的 `config.env`），别放进聊天、别粘进公共笔记；
- **填 `OCS_CERT_SHA256`** 做证书固定；OCS 重装/换 IP 后证书可能重新生成，届时换新指纹；
- **给飞书侧配白名单**（`dmPolicy: allowlist` / `allowFrom`）：能跟这个机器人说话 = 能操作你的浏览器；
- 日志接口已在 OCS 侧脱敏（账号密码替换成 `***`，响应里的 `masked` 是替换次数），但**截图没有脱敏**——画面里有课程内容，别转发；
- 关闭浏览器、加/删自动化程序这类动作会改状态，建议让 agent 先确认（工具描述里已注明）。

## 五、本机自测

```bash
node check-ocs.mjs --uid <uid>   # 对着**真实** OCS 自检（在机器 B 上跑），逐项给结论
node test/run.mjs                 # 假 OCS + 29 项断言，不碰真机：
                                  # 证书固定/密钥校验/错误码、MCP 握手与工具、推送的基线/去重/掉线提醒
node test/serve-mock.mjs          # 手动玩：打印可复制的 OCS_BASE/KEY/指纹，每 20 秒追加一行日志
```

不碰真机也能验证这几个脚本：

```bash
node test/run.mjs         # 起假 OCS（HTTPS+自签证书），跑 29 项断言：
                          # 证书固定/密钥校验/错误码、MCP 握手与工具、推送的基线/去重/掉线提醒
node test/serve-mock.mjs  # 手动玩：打印可复制的 OCS_BASE/KEY/指纹，每 20 秒追加一行日志
```

需要 Node 20+；生成测试证书需要 `openssl`（Git for Windows 自带，Linux/macOS 自带）。

## 六、已知边界

- **页面里用户脚本画的提示拿不到**（验证码弹窗、"章节全部完成"属于页面 DOM）。日志接口给的是
  桌面侧的输出：脚本安装、自动化程序上报的事件（登录成功/需要人工处理验证码…）、报错。
  要那些页面提示只能截图看，或改用户脚本主动上报（未做）。
- **浏览器关掉后没有历史日志**（日志只在渲染进程内存里），所以"昨晚为什么停了"这类事后追查目前做不到。
- 从飞书**回填验证码/点页面按钮**需要 OCS 提供页面动作接口（`actions`，尚未开放）。

## 七、DSH 和 OCS 装在同一台机器上（推荐）

同机最省事：**全部走回环**——不用管防火墙，OCS 的远程 API 还可以只监听 `127.0.0.1`。
（第二节/第三节那些步骤照做，只是把地址换成回环；下面是同机的完整清单。）

### 0. 先确认三件事

```bash
ls ~/.dsh/profiles/                                   # profile 名：dsh web 一般是 web，桌面 App 是 desktop
ls "/opt/OCS Desktop/resources/app" >/dev/null && echo "OCS 装在本机"
ps -ef | grep -i -E "dsh|harness" | grep -v grep      # 记下 DSH 是怎么起的（systemd？手动 dsh web？）
```

**DSH 数据目录一般是 `$HOME/.dsh`**（`dsh web` 用 `profiles/<名字>`，桌面 App 用 `profiles/desktop`），
但 DSH 可能以**别的用户**运行（常见：DSH 用 root、OCS 用普通用户）。OCS ≥ 2.13.11 的设置页会自动检测：

- 先扫 `/proc/<pid>/cmdline` 找运行中的 DSH 进程，读 `/proc/<pid>/status` 的 Uid 反查 `/etc/passwd`
  得到运行用户的 home → `<home>/.dsh`；同用户时还会直接读进程的 `DSH_HOME`；
- 再依次试 OCS 自己的 `DSH_HOME`、`~/.dsh`、`/root/deepseek-harness`、`~/deepseek-harness`、`/home/*/.dsh`；
- 每个候选都同时认 `<目录>/profiles` 与 `<目录>/.dsh/profiles`；
- 找到但**当前 OCS 用户读不了**时不会说"没检测到"，而是明确显示
  「检测到 X，但当前用户（A）无权读取——DSH 由 B 运行」，并在卡片上给出可复制的 root 命令。

> **跨用户也能在设置页里直接配置**（OCS ≥ 2.13.13）：卡片上的「授权 OCS 访问」会通过 polkit
> 弹出系统认证框，以 root 执行一次 `setfacl`——祖先目录只加穿透 `x`，`profiles/` 及其子项加
> `rwX` 并设置默认 ACL（DSH 以后新建的 profile/备份同样继承）。授权后不需要再 sudo，
> 选 profile、生成密钥、写入都在设置页完成。
>
> - 只改 ACL，不改属主与权限位；撤销：`sudo setfacl -R -x u:<OCS用户> <DSH目录>/profiles`。
> - 没有图形会话或没有 polkit 认证代理时，自动授权会失败，卡片会显示等价的
>   `sudo /bin/sh -c '…'` 命令供复制执行（效果相同）。
> - 不想授权也可以：用卡片上的 root 命令跑 `setup-same-host.sh`（一次性写入），
>   或把 DSH 改成和 OCS 同一个用户运行。授权后 OCS 用户即可读写 DSH 的 profiles 配置目录。

**都不确定时，手工定位**（最可靠）：

```bash
# ① 看 DSH 进程实际用的 HOME / DSH_HOME
pgrep -af dsh; PID=$(pgrep -f 'dsh|harness' | head -1); tr '\0' '\n' < /proc/$PID/environ | grep -E '^(HOME|DSH_HOME)='
# ② 直接找 patch 文件，它的上两级就是数据目录
find /root /home /opt /var -maxdepth 6 -type f -name 'cordis.patch.yml' 2>/dev/null
```

> `/root/deepseek-harness` 只是**源码/安装**目录时，里面不会有 `profiles/`——数据在 `DSH_HOME` 或运行用户的 `~/.dsh` 下。
> 实测例：源码在 `/root/deepseek-harness`、进程环境 `DSH_HOME=/root/.dsh` → 数据目录就是 `/root/.dsh`，profile 为 `web`。

### 1. 放脚本（别放进 OCS 的安装目录）

`/opt/OCS Desktop/` 是 OCS 应用的安装目录，升级会整个替换掉。

```bash
sudo mkdir -p /opt/ocs-bridge && sudo chown "$USER" /opt/ocs-bridge
scp -r tools/ocs-openclaw/* <user>@<本机>/opt/ocs-bridge/     # 从你开发机拷
```

### 2. OCS 侧：远程 API 只绑回环

设置 → 远程 API：**开启**，监听地址选 **`127.0.0.1`**，端口 `15320`，生成密钥并复制（明文只显示一次）。

```bash
curl -k https://127.0.0.1:15320/api/v1/health     # 看 listening / rendererReady / certFingerprint
```

> ⚠️ 绑 `127.0.0.1` 后，**局域网里其他机器就直连不了了**。你们的网关若走 SSH 反向隧道（目标也是本机回环），不受影响；
> 若还有别的 LAN 客户端直连，就保持 `0.0.0.0`。

### 3. 自检（先排除网络/密钥/证书问题）

```bash
cd /opt/ocs-bridge
export OCS_BASE=https://127.0.0.1:15320
export OCS_API_KEY='……'            # 还没拿到就先不填，脚本会只测连通性
export OCS_CERT_SHA256='……'         # 可选但建议
node check-ocs.mjs --uid <某个浏览器uid>
```

全绿再改 DSH 配置。

### 4. DSH 配置

**首选：在 OCS 设置页点一下**——「设置 → AI 助手接入（DSH）」：

- 自动检测 DSH 数据目录（`DSH_HOME` / `~/.dsh` / `/root/deepseek-harness` / `~/deepseek-harness`，
  并能自动钻进 `<目录>/.dsh`）；也可以手工填——**填哪一层都行**，程序会找 `profiles/` 在哪；
- **DSH 与 OCS 不同用户时**（如 DSH 用 root）：点「授权 OCS 访问」，polkit 弹窗认证一次后
  以 root 加 ACL，之后这里就能直接读写配置；没有 polkit 代理时会给出等价的 sudo 命令；
- 选 profile、确认 OCS 地址（默认 `https://127.0.0.1:<端口>`）、填密钥（没有就点「生成新密钥」，会顺手填入）；
- 点「写入 DSH 配置」：写一段**带标记的受管块**（重复点只覆盖那一段）、自动备份、文件权限 600；
- **主动通知**也在同一页：填 Bot ID / 目标 ID，打开开关即可（OCS 常驻 `ocs-watch --deliver dsh`，
  零 token，随 OCS 启停，配置加密保存）；见第九节；
- 卡片里会直接给出下一步（重启 DSH）和通知命令。

桥接脚本随应用发布（`resources/tools/ocs-openclaw/`），**不需要手工拷**；
写入时用的是应用自带的这份路径。

**没有图形界面时：跑脚本**（逻辑与设置页一致）：

```bash
cd /opt/ocs-bridge
bash setup-same-host.sh                 # 交互式：列 profile、要密钥
# 非交互：bash setup-same-host.sh --profile web --key '……'
```

**手动写法**（需要细调时）：编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: ocs-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ocs
        transport: stdio
        # node 不在 DSH 进程的 PATH 里时写绝对路径（which node）
        command: node
        args: ['/opt/ocs-bridge/ocs-mcp-server.mjs']
        cwd: '/opt/ocs-bridge'
        env:
          OCS_BASE: 'https://127.0.0.1:15320'
          OCS_API_KEY: '……'
          OCS_CERT_SHA256: '……'
        toolCallTimeoutMs: 30000
        failOnStartupError: false
```

### 5. 权限与重启

```bash
sudo chown -R <跑DSH的用户> /opt/ocs-bridge     # DSH 用户要能读这些脚本
systemctl restart <dsh服务>                     # 或按第 0 步记下的方式重新拉起
```

验证：问 agent「列一下 OCS 里的浏览器」，工具名 `mcp__ocs__*`；没出现就看 DSH 启动日志里 `dsh-mcp-client` 的报错。

### 6. 通知（同机最顺）

主动投递接口就在本机：`http://127.0.0.1:3080/api/dsh-im/delivery/messages`
（端口以 DSH 启动时显示的为准，`ss -lntp | grep -E '3080|dsh'` 可查）。

```bash
export DSH_BOT_ID='bot_…' DSH_TARGET_ID='tgt_…'
node ocs-watch.mjs --loop --every 60 --deliver dsh
```

### 7. 万一以后拆成两台机器

| 项 | 同机（现在） | 不同机 |
| --- | --- | --- |
| `OCS_BASE` | `https://127.0.0.1:15320` | `https://<OCS机器的局域网IP>:15320` |
| OCS 远程 API 监听 | `127.0.0.1` | `0.0.0.0` + 放行 TCP 15320 |
| 证书指纹 | 建议填 | 建议填（走网络更要固定） |
| 通知投递地址 | `127.0.0.1:3080` | DSH 所在机器的地址（该接口无鉴权，别跨不可信网络） |

## 八、省 token：什么时候该走对话、什么时候别走

**只要走对话，就一定花 token。** 花钱的不是工具本身（它只是发个 HTTP 请求），而是模型这一轮：
系统提示 + **工具定义（每轮都随请求发）** + 对话历史 + 工具返回的内容，全都算进上下文。
实测这份工具体系 `TOOLS` 块约 3.6KB ≈ **1.3k token/轮**，描述只占其中 0.7KB，大头是 12 个工具的 schema。

### 1. 不想花 token：别经过 agent

| 需求 | 做法 | token |
| --- | --- | --- |
| 看一眼浏览器列表 | `curl -k -H "X-API-Key: …" https://127.0.0.1:15320/api/v1/browsers` | 0 |
| 通过你们网关看 | `GET /v1/ocsdesktop/browsers`（网关已经实现了这条） | 0 |
| 定时/事件推送 | `ocs-watch.mjs --once`（cron / systemd timer）→ 飞书 | 0 |
| 页面前端上点 | 网关管理页直接调接口 | 0 |

只有"需要模型理解一句话再决定调什么"的场景（"把智慧树那台重启一下"）才值得走对话。

### 2. 必须走对话时的省法

- **`OCS_MCP_TOOLSET=basic`**：只注册常用 8 个工具（health / list / get / launch / close / pages / screenshot / logs），
  省掉 task、add_script、remove_script、automation_scripts 四个的 schema。
  在 DSH 的 `config.env` 里加一行即可：`OCS_MCP_TOOLSET: "basic"`。
- **列表默认是紧凑格式**（一行一个浏览器：名称 / uid / 状态）；要备注、标签、脚本名再加 `detailed: true`。
- **日志默认 60 行、且最多回 4000 字符**（保留末尾最新的内容）——整段日志塞进上下文很贵，
  要看完整日志直接查 `/api/v1/browsers/:uid/logs`。
- **`ocs_screenshot` 是最贵的工具**（图片按图像 token 计），只在真的需要"看画面"时调；能用日志说清楚的就别截图。

## 九、把 OCS 的通知直接发到 IM（零 token）

DSH 的 IM 插件（`@xmanrui/dsh-im`）提供**主动投递**接口：外部程序可以直接往已绑定的聊天发文本，
**不经过模型**，所以不花 token。`ocs-watch.mjs` 已经支持把通知投到那里。

### 1. 能通知什么

| 来源 | 内容 | 备注 |
| --- | --- | --- |
| 日志 | 脚本安装、登录成功/失败、**检测到验证码（尝试自动识别 / 需要人工处理）**、报错、超时 | 账号密码已被 OCS 侧脱敏成 `***` |
| 状态 | `launched → closed`、掉线（orphaned）、`closed → launched` | 只报变化，不刷屏 |
| 连通性 | OCS 连不上 / 恢复 | 只在状态翻转时各提醒一次 |
| 页面里的提示 | ❌ 拿不到 | 验证码弹窗、"章节全部完成"属于页面 DOM，只能截图看（见第六节） |

### 2. 在 DSH 里拿到 `botId` + `targetId`

1. 「设置 → IM机器人」→ 目标机器人的齿轮 → 「调用标识」里复制 **Bot ID**。
2. 「新建目标」→ 从**已聊会话**里选（先去飞书/微信给机器人发一条消息，它才会出现在候选里）
   → 「测试」确认能收到 → 「保存目标」。
3. 点该目标的「复制调用参数」，得到 `{ "botId": "bot_…", "targetId": "tgt_…" }`。

### 3. 跑起来（二选一）

> **OCS ≥ 2.13.13 可以直接在设置页里启用**：「设置 → AI 助手接入（DSH）→ 主动通知」，
> 填 Bot ID / 目标 ID、打开开关即可——进程由 OCS 拉起，随 OCS 退出，密钥随设置加密保存，
> 不需要终端。下面的命令行方式适用于不用 OCS 界面或想独立部署的场景。

```bash
cd /opt/ocs-bridge
export OCS_BASE=https://127.0.0.1:15320 OCS_API_KEY='…'
export DSH_BOT_ID='bot_…' DSH_TARGET_ID='tgt_…'

# A. 常驻（推荐：延迟 ≈ --every 秒）
node ocs-watch.mjs --loop --every 60 --deliver dsh

# B. 一次性：交给 cron / systemd timer（例如每 3 分钟）
node ocs-watch.mjs --once --deliver dsh
```

systemd timer 示例（`/etc/systemd/system/ocs-watch.service` + `.timer`）：

```ini
# ocs-watch.service
[Service]
Type=oneshot
WorkingDirectory=/opt/ocs-bridge
Environment=OCS_BASE=https://127.0.0.1:15320
Environment=OCS_API_KEY=…
Environment=DSH_BOT_ID=bot_…
Environment=DSH_TARGET_ID=tgt_…
ExecStart=/usr/bin/node /opt/ocs-bridge/ocs-watch.mjs --once --deliver dsh
```

投递地址默认 `http://127.0.0.1:3080/api/dsh-im/delivery/messages`（DSH 的 Web 服务端口），
不是 3080 就用 `--dsh-url` 或 `DSH_DELIVERY_URL` 指定。

### 4. 手动验一下投递本身

```bash
curl -X POST http://127.0.0.1:3080/api/dsh-im/delivery/messages \
  -H 'Content-Type: application/json' \
  -d '{"botId":"bot_…","targetId":"tgt_…","text":"OCS 通知通道测试"}'
# 返回 {"sent":true}，聊天里应该立刻收到
```

### 5. 行为细节

- **首次运行只做基线**：不会把历史日志全推一遍；之后只发新增的内容。
- **同一行不会重复发**（状态文件 `~/.ocs-watch-state.json` 记已播报内容的指纹）；
  想重新基线就加 `--reset`。
- **投递失败不会弄死看门狗**：只往 stderr 记一条，下一轮继续；
  缺 `DSH_BOT_ID`/`DSH_TARGET_ID` 会在启动时以退出码 2 拒绝（避免每轮静默失败）。
- ⚠️ DSH 的投递 HTTP 接口**没有鉴权、不带 CORS**，只应在本机/可信网络用——
  `ocs-watch.mjs` 和 DSH 在同一台机器时最合适；别把这个端口暴露到公网。

### 6. 不想用 DSH 的投递接口？

`--deliver stdout`（默认）仍然是原来的行为：把文本打到标准输出，交给 OpenClaw 的 `cron --command --announce`
或你自己的通知脚本。`--deliver none` 则只记状态不输出。
