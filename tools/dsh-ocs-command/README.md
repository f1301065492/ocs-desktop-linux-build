# DSH `/ocs` 命令（本地执行，零 token）

在 DSH 聊天里用 `/ocs` 直接调用 OCS 的远程 API：查看浏览器、读日志、启停、查任务。

命令的 handler 在 DSH 本地运行，结果由命令 UI 直接渲染——**不进入模型上下文，不花 token**。
这和"让 agent 调 MCP 工具"是两条路：后者需要模型理解一句话再决定调什么，前者是固定指令。

> 命令名只能是小写 ASCII（DSH 注册时校验 `/^[a-z][a-z0-9_-]*$/`），所以固定用 `/ocs`；
> **子指令和参数全部支持中文**。

## 安装

在 OCS 那台机器上：

```bash
sudo mkdir -p /opt/ocs-command && sudo cp -r tools/dsh-ocs-command/* /opt/ocs-command/
```

```bash
sudo bash /opt/ocs-command/install.sh --base https://127.0.0.1:15320 --key '远程 API 密钥'
```

证书指纹建议带上（`/ocs 健康` 或 OCS 设置页可查）：

```bash
sudo bash /opt/ocs-command/install.sh --base https://127.0.0.1:15320 --key '…' --fingerprint 'AB:CD:…'
```

默认装到 `DSH_HOME=/root/.dsh` 的 `web` profile；其它情况用 `--dsh-home` / `--profile` 指定。
安装脚本会：

1. 复制插件到 `<DSH_HOME>/profiles/web/node_modules/ocs-command/`；
2. 在 `cordis.patch.yml` 写入一段**带标记**的配置（重复执行只替换这一段，先备份、权限 600）；
3. 提示重启 DSH。

重启后输入 `/ocs 帮助`。

## 命令

| 指令 | 说明 |
| --- | --- |
| `/ocs 帮助` | 列出所有子指令（也支持 `help` / `?`） |
| `/ocs 列表` | 浏览器列表：名称 / uid / 状态（别名：列举、浏览器、list、ls） |
| `/ocs 查看 <名称\|uid>` | 单个浏览器详情（不显示账号密码） |
| `/ocs 日志 <名称\|uid> [行数]` | 最近日志，默认 60 行，已脱敏（别名：记录、logs） |
| `/ocs 启动 <名称\|uid>` | 启动浏览器，返回任务 ID（别名：打开、开始、launch） |
| `/ocs 关闭 <名称\|uid>` | 关闭浏览器，返回任务 ID（别名：停止、close） |
| `/ocs 任务 <任务ID>` | 查询异步任务结果 |
| `/ocs 健康` | 远程 API 版本 / 监听状态 / 证书指纹 / 地址 |

`<名称|uid>` 支持：完整 uid、uid 前缀（建议 ≥6 位）、浏览器名称（精确或唯一包含）。
匹配到多台时会列出候选，让你改用更精确的写法。

示例：

```
/ocs 列表
/ocs 日志 测试 80
/ocs 启动 c026de85
/ocs 任务 3f9a1c2b
```

## 配置

安装脚本写入的片段（也可手工加到 `cordis.patch.yml`）：

```yaml
- insert:
    - id: ocs-command
      name: ocs-command
      config:
        base: 'https://127.0.0.1:15320'
        apiKey: '……'
        certFingerprint: 'AB:CD:……'
```

- `base`：OCS 远程 API 地址（必须在 OCS 设置里开启远程 API）。
- `apiKey`：远程 API 密钥；与 MCP 桥接用的是同一个。
- `certFingerprint`：自签证书的 SHA-256 指纹；留空则不校验（不建议）。

## 安全说明

- 密钥写在 `cordis.patch.yml` 里，安装脚本会把文件权限设为 600；不要提交到仓库。
- 命令输出**不进入模型上下文**；日志接口在 OCS 侧已把账号密码替换为 `***`。
- `/ocs 查看` 不会打印账号密码字段，只显示名称、状态、标签、备注、自动化程序。
- 命令只能做固定动作（查列表/日志/启停/任务/健康）；自然语言操作仍走 agent + MCP（花 token）。

## 在 IM 机器人（飞书）里使用

DSH 的 IM 桥接只识别内置命令（`/new` `/compact` `/status` …），**未知的 `/xxx` 会被当成普通提问发给模型**
（源码注释：`Unknown slash-prefixed text remains an ordinary prompt`）。所以默认情况下，在飞书里发
`/ocs 列表` 会走 agent、花 token，而不是走本地命令。

要让它也走本地命令，需要给飞书桥接打一个小补丁：

```bash
sudo bash tools/dsh-ocs-command/patch-im-bridge.sh --dsh-home /root/.dsh --profile web
```

脚本会在插件**实际加载的打包产物** `@xmanrui/dsh-im/lib/index.js` 的飞书命令分支里插入一段拦截
（注意不是 `src/`——`package.json` 的 `main` 指向 `lib/index.js`，改 `src` 不会生效）：

- 匹配 `^/ocs(\s|$)` → 通过 Harness 的命令网关执行（与网页里相同的 `/ocs` 命令，零 token）；
- 把命令结果直接回复到当前聊天；
- 带标记、可重复执行；先备份（备份名含时间戳，重复执行也不会覆盖），`--revert` 恢复最早那份原始文件；
- 写完后用 `node --check` 校验，失败自动回滚。

然后重启 DSH，在飞书私聊里发 `/ocs 帮助`。

注意：

- 这是**对第三方插件源码的补丁**，`@xmanrui/dsh-im` 升级后会被覆盖，重新执行一次脚本即可。
- 目前只适配了飞书；企微桥接的命令分发结构不同，需要单独适配。
- 群聊里仍受 DSH 的回复模式（必须 @ 机器人）和访问策略限制。
- 还没建立会话时发 `/ocs` 会提示先发一条普通消息（命令网关需要绑定会话）。

## 卸载

```bash
sudo rm -rf /root/.dsh/profiles/web/node_modules/ocs-command
```

再从 `cordis.patch.yml` 删掉 `# >>> ocs-command …` 到 `# <<< ocs-command <<<` 之间的内容，重启 DSH。

## 备注

- 插件是零依赖的普通 ESM 包，放在 profile 的 `node_modules` 下由 Node 直接解析。
  之后如果对 profile 执行 `pnpm install`/`dsh plugin` 等操作把该目录清掉，重新跑一次安装脚本即可。
- 后续可以让 OCS 设置页在写入 MCP 配置时顺带写这段 `ocs-command` 配置，省掉手工步骤。
