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

## 四、自动同步上游

`.github/workflows/upstream-sync.yml` 每天 03:17 UTC 检查一次上游 `main`：

1. 若 `upstream/main` 已是 `main` 的祖先 → 无事发生。
2. 尝试 `git merge upstream/main`：
   - **能干净合并**：安装依赖 → common 构建 → 主进程 `tsc --noEmit` → 渲染进程 `vue-tsc --noEmit` → 桥接工具自测。
     全绿后，定时任务默认**直接并入 main**（手动触发默认只开 PR）。
   - **冲突或检查失败**：**不动 main**，自动开/更新一个 `upstream-sync` issue，里面带冲突文件列表和运行链接。
3. 手动触发：`gh workflow run upstream-sync.yml --field mode=pr`（只开 PR）或 `--field mode=direct`（检查通过直接并）。

几点约束：

- 历史关联已在 `d339ea4` 建立：以本仓库快照对应的上游提交 `ecc6bb7`（2026-07-19）为第二父提交。
  以后才能做真正的三方合并，不要删除这个合并提交的历史关系。
- **PR 必须用 merge commit 合并，不能 squash / rebase**，否则上游提交不会成为 `main` 的祖先，
  下一轮会把同一批更新再同步一遍。
- Actions 用 `GITHUB_TOKEN` 推送不会触发其它 workflow（GitHub 的限制），所以检查是在
  `upstream-sync` 任务里自己跑的；不要把它简化成“只开 PR、等 CI”。
- `main` 若有分支保护、不允许 Actions 直接 push，任务会自动回退成 PR 模式。
- **令牌要求**（二选一）：
  1. 仓库 Settings → Actions → General → Workflow permissions 设为 **Read and write**；
  2. 或添加 Actions secret `UPSTREAM_SYNC_TOKEN`（fine-grained PAT，仓库权限需要
     **Contents / Issues / Pull requests / Workflows** 四项 Read and write，Metadata 自动只读）。
  两者都没有时，任务仍会检查并尝试合并，但无法推送/建 issue；冲突和失败信息会写进该次
  Actions 运行的 **Summary**，运行本身标记为失败。
- 细粒度 PAT 对部分 GraphQL 写操作会返回 `Resource not accessible by personal access token`，
  所以工作流**建 issue、评论、建 PR 都走 REST 接口**（`gh api`），不要改回 `gh issue create` /
  `gh pr create`。
- **第一次同步（2.13 → 3.x）跨度很大**：上游把构建链迁到了 electron-vite、类型下沉到 common、
  重做了界面与加密，实测有 30 处冲突，必然走“手动合并”路径；按第五节处理完这一次以后，
  后续小版本更新才能稳定自动合并。


## 五、手动同步上游（自动合并失败时）

**方式 A：直接解冲突（推荐，适用于小范围更新）**

1. 取回上游：
   ```bash
   git remote add upstream https://github.com/ocsjs/ocs-desktop.git   # 只需一次
   git fetch upstream --tags
   ```
2. 在分支上合并：
   ```bash
   git switch -c sync/upstream-<日期> main
   git merge upstream/main
   ```
3. 按第三节处理冲突：`ext/` 内保留我们的实现；上游钩子文件按 `[ocs-ext]` 重新落；
   “整体替换/大改”的文件人工合并，不要直接覆盖。
4. 验证（见下节），通过后用 **merge commit** 合回 `main`。

**方式 B：换基线（适用于 3.x 这种大重构）**

1. `git fetch upstream --tags`
2. `git switch -c sync/upstream-<版本> upstream/<版本>`
3. 整体搬运扩展目录：
   ```bash
   git checkout main -- packages/app/src/ext packages/web/src/ext tools 远程API说明.md
   ```
4. 对照第三节，把 `[ocs-ext]` 行加到新版本对应文件的相同位置。
   钩子总量很小（每个文件 1–3 行）；若上游文件结构变化，用
   `git diff d339ea4^1..main -- <文件>` 看本分支当初是怎么接的。
5. 重新落“整体替换/大改”的文件（见第三节表格）。
6. 验证通过后，以 **merge commit** 合回 `main`。

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

## 六、只留本地的文件

以下文件被 `.gitignore` 忽略，**不提交、不推送**：

- `交接文件.md`（本机工作记录）
- `OCS网关待补接口.md`
- `CLAUDE.md`

提交时按路径显式 `git add`，不要用 `git add -A`。
