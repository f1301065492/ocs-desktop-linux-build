# 上游同步指南（FORK）

本仓库是 [ocsjs/ocs-desktop](https://github.com/ocsjs/ocs-desktop) 的定制分支。
为了让后续合并上游更新时冲突面尽量小，**所有新增功能都放在独立的 `ext/` 目录里**，
上游文件只保留少量带 `[ocs-ext]` 标记的钩子行。

> 基线：`4d3e596`（上游 v2.13.0 的快照 + Linux 构建工作流）。
> 查当前所有钩子：`git grep -n "\[ocs-ext\]"`。

---

## 一、目录约定

```
packages/app/src/ext/            主进程扩展（新增功能全部在这里）
├── boot.ts                      扩展服务启动 / 退出清理（远程 API、SSH 隧道）
├── ipc.ts                       通过 IPC 暴露给渲染进程的扩展方法集合
├── defaults.ts                  electron-store 的扩展默认配置
├── portable.ts                  可移植（密码）加解密
├── page-notify.ts               页面内通知捕获（注入脚本 + console 转发）
├── login-state.ts               启动前清除登录状态
├── worker-ext.ts                远程 API 用的 worker 能力（页面列表 / 截图）
├── remote-api/                  远程 HTTPS API（15 条路由、鉴权、TLS、任务、SSE）
├── dsh/                         DSH 接入：bridge / IM 补丁 / 主动通知
├── ssh/                         SSH 反向隧道
└── update/                      更新源、镜像清单解析、跨平台更新、分片下载

packages/web/src/ext/            渲染进程扩展
├── persist.ts                   store 持久化（单次 IPC 加密 + 写入）
├── portable.ts                  导出/导入的口令交互
├── dsh/{notify,autostart,store}.ts
├── remote-api/{worker,state}.ts
└── settings/                    设置页卡片（ExtSettingsCards 一次挂载四张；另含登录状态开关）

tools/ocs-openclaw/              聊天助手桥接（MCP / 通知 watcher / 自检 / 测试）
tools/dsh-ocs-command/           DSH `/ocs` 命令插件
tools/update-mirror/             自建更新源同步脚本与 nginx 配置
远程API说明.md                    远程 API 使用文档
```

**规则**：新增功能只改 `ext/`；确实要接入上游流程时，只加一行带 `[ocs-ext]` 的调用，
不要在钩子旁边写大段业务逻辑。

---

## 二、新增功能 → 代码位置

| 功能 | 主进程 | 渲染进程 | 其它 |
| --- | --- | --- | --- |
| 远程 API（HTTPS，默认 15320） | `ext/remote-api/`、`ext/ipc.ts` | `ext/remote-api/worker.ts`、`ext/remote-api/state.ts`、`ext/settings/RemoteApiSetting.vue` | `远程API说明.md` |
| DSH 一键接入 / 跨用户授权 | `ext/dsh/bridge.ts`、`ext/ipc.ts` | `ext/settings/DshBridgeSetting.vue` | `tools/ocs-openclaw/setup-same-host.sh` |
| 飞书 `/ocs` 命令补丁 | `ext/dsh/im.ts` | `ext/settings/DshBridgeSetting.vue` | `tools/dsh-ocs-command/` |
| 主动通知（实时 + 轮询） | `ext/dsh/notify.ts` | `ext/dsh/notify.ts`、`ext/dsh/autostart.ts`、`ext/settings/DshBridgeSetting.vue` | `tools/ocs-openclaw/ocs-watch.mjs` |
| SSH 反向隧道 | `ext/ssh/tunnel.ts`、`ext/ipc.ts` | `ext/settings/SshTunnelSetting.vue` | — |
| 自建更新源 / 跨平台更新 | `ext/update/{source,manifest,updater,download}.ts` | `ext/settings/UpdateSourceSetting.vue` | `tools/update-mirror/` |
| 数据导出/导入（可移植格式） | `ext/portable.ts`、`ext/ipc.ts` | `ext/portable.ts` | — |
| 页面内「需要人工」通知 | `ext/page-notify.ts` | — | — |
| 启动前清除登录状态 | `ext/login-state.ts` | `ext/settings/ClearLoginOnLaunchSetting.vue` | — |
| store 持久化 | — | `ext/persist.ts` | — |

---

## 三、上游文件里的钩子

这些文件只允许保留表中列出的改动；其余逻辑都应在 `ext/` 里。

| 上游文件 | 钩子（搜索关键字） |
| --- | --- |
| `packages/app/index.ts` | `startExtServices`、`shutdownExt`、`[ocs-ext]` |
| `packages/app/src/store.ts` | `...EXT_APP_STORE_DEFAULTS` |
| `packages/app/src/tasks/remote.register.ts` | `...EXT_METHODS`、`protectMainProcessOwnedKeys`、`attachExtIpc` |
| `packages/app/src/utils/index.ts` | `export { downloadFile } from '../ext/update/download'` |
| `packages/app/src/crypto.ts` | 仅延迟 logger（可移植加密已移到 `ext/portable.ts`） |
| `packages/app/src/worker/index.ts` | `listPagesExt`、`screenshotPageExt`、`clearLoginState`、`PAGE_NOTIFY_SCRIPT`、`installPageNotifier` |
| `packages/web/src/App.vue` | `ext/persist`、`startRemoteApiWorker`、`startDshNotifyIfEnabled` |
| `packages/web/src/components/SettingPanel.vue` | `<ExtSettingsCards />`、`<ClearLoginOnLaunchSetting />` |
| `packages/web/src/components/Title.vue` | `decryptImportedRender`、`askExportPassword`、`encryptRenderForExport` |
| `packages/web/src/store/index.ts` | `DEFAULT_DSH_NOTIFY`、`migrateDshNotify`、`clearLoginOnLaunch`、`dshNotify` 类型 |
| `packages/web/src/fs/interface.ts` | `BrowserRemoteMeta`、`userscriptVersions`、`remoteMeta` |
| `packages/web/src/fs/browser.ts` | `userscriptVersions`、`remoteMeta`、启动并发防护 |
| `packages/web/src/utils/process.ts` | `notifyRealtime`、`clear_login_on_launch`、`appendLogs` |
| `packages/web/src/utils/browser.ts` | `newBrowser` 的 `parentUid / uid / silent / remoteMeta` 选项 |
| `packages/web/src/utils/script-version.ts` | 按浏览器取已安装版本；远端无 `meta.js` 时回退正文解析 |

### 被整体替换 / 大改的上游文件

| 文件 | 说明 |
| --- | --- |
| `packages/app/src/tasks/updater.ts` | 只剩一行 `export { updater, updateApp } from '../ext/update/updater'`；实现按平台分流并支持自建更新源 |
| `packages/app/src/tasks/startup.server.ts` | 安全修复：CORS 收紧到本机白名单、只绑定 `127.0.0.1`、预检拒绝非白名单来源 |
| `packages/app/script.js` | 子进程 `unhandledRejection` 兜底（防止浏览器进程被未捕获异常杀掉） |
| `packages/app/src/worker/index.ts` | 除钩子外还有 `waitAndCloseExtensionHomepage` 不抛异常化（线上崩溃修复） |
| `packages/web/src/utils/process.ts` | 除钩子外还有启动前置检查抛错、关闭超时、日志缓冲上限等生命周期修复 |
| `packages/web/src/fs/entity.ts` | `uuid()` 优先 `crypto.randomUUID()` |
| `packages/web/src/components/browsers/*` | `launch().catch()`，避免前置检查失败产生未捕获 rejection |
| `packages/app/src/scripts/automation/wk/*.ts` | 智慧树等登录脚本按线上改版重写 |
| `packages/app/types.ts` | `lastInstalledVersion` 标记为废弃（改按浏览器记录） |

### 构建 / 发版相关（与上游功能无关）

- `.github/workflows/release.yml`：仅 patch 发版（上游的 release-please 已删除）。
- `.github/workflows/build-linux-appimage.yml`、`packages/app/electron.builder.json`：Linux 打包、deb 依赖、图标、`tools/` 随包发布。
- `packages/app/build/icons/`：多尺寸图标集。
- `.gitignore`：忽略三份只留本地的文件。

---

## 四、同步上游的步骤

1. **确认上游目标版本**并取回：
   ```bash
   git remote add upstream https://github.com/ocsjs/ocs-desktop.git   # 只需一次
   git fetch upstream --tags
   ```
2. **以新版本为基线新建工作分支**（不要在本分支直接 merge，历史是快照开始的、无共同祖先）：
   ```bash
   git switch -c sync/upstream-<版本> upstream/<版本>
   ```
3. **整体搬运扩展目录**（它们不依赖上游内部实现，只依赖公开导出）：
   ```bash
   git checkout main -- packages/app/src/ext packages/web/src/ext tools 远程API说明.md
   ```
4. **重新落钩子**：对照第三节，把 `[ocs-ext]` 行加到新版本对应文件的相同位置。
   钩子总量很小（每个文件 1–3 行）；若上游文件结构变化，用
   `git diff 4d3e596..main -- <文件>` 看本分支当初是怎么接的。
5. **重新落“整体替换/大改”的文件**：优先把上游的新实现与我们的改动做人工合并，
   不要直接 `git checkout main --` 覆盖（会丢上游新功能）。
6. **验证**（见下节），通过后把 `sync/upstream-<版本>` 合回 `main` 或直接以其为准。

### 验证命令

```bash
# 主进程类型检查
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
  ./node_modules/typescript/lib/tsc.js -p packages/app/tsconfig.json

# 渲染进程类型检查 + 构建
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
  ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p packages/web/tsconfig.json
cd packages/web && ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe \
  ../../node_modules/vite/bin/vite.js build --emptyOutDir

# Lint（只检查改动范围）
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
  ./node_modules/eslint/bin/eslint.js "packages/app/src/ext/**/*.ts" "packages/web/src/ext/**/*.{ts,vue}"

# 桥接工具自测（56 项，不需要真机）
cd tools/ocs-openclaw && node test/run.mjs
```

> Windows 无独立 Node 时用仓库里的 Electron 当 Node 跑，见 `交接文件.md` 第六节。

---

## 五、只留本地的文件

以下文件被 `.gitignore` 忽略，**不提交、不推送**：

- `交接文件.md`（本机工作记录）
- `OCS网关待补接口.md`
- `CLAUDE.md`

提交时按路径显式 `git add`，不要用 `git add -A`。
