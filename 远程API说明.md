# OCS Desktop 远程 API 调用说明

> 适用版本：2.13.0 及以后
> 本文档面向**调用方**（需要从其他机器控制 OCS Desktop 的开发者）。
> 实现细节与项目背景见 [交接文件.md](交接文件.md)。

---

## 一、快速开始

### 1. 在 OCS Desktop 上开启

打开「软件设置 → 远程 API」：

1. 点「生成密钥」——**明文只显示这一次**，关闭后无法再查看，只能重新生成
2. 打开「启用远程 API」开关
3. 按需选择监听地址：
   - `0.0.0.0` —— 允许局域网内其他机器访问
   - `127.0.0.1` —— 仅本机
4. 记下页面上显示的**可用访问地址**和**证书指纹**

### 2. 验证连通

```bash
# 健康检查不需要密钥
curl -k https://192.168.1.30:15320/api/v1/health
```

```json
{
  "data": {
    "ok": true,
    "version": "2.13.0",
    "panel": { "enabled": true, "port": 15320, "bindAddress": "0.0.0.0", "hasKey": true, "keyCreatedAt": 1789297300135 },
    "listening": true,
    "rendererReady": true,
    "certFingerprint": "81:62:2A:...:79",
    "addresses": ["192.168.1.30"]
  },
  "requestId": "..."
}
```

`rendererReady` 为 `true` 才表示接口可以正常干活——应用刚启动时可能还是 `false`，
此时其他接口会返回 `503`。

### 3. 第一个调用

```bash
KEY=你的密钥
BASE=https://192.168.1.30:15320

curl -k -H "X-API-Key: $KEY" $BASE/api/v1/browsers
```

---

## 二、通用约定

### 地址与端口

- 默认端口 **15320**（可在设置页修改）
- **自签证书 HTTPS**。`curl` 需要加 `-k`；程序调用需要跳过证书校验或固定证书指纹
- **固定指纹比直接关闭校验安全得多**。设置页显示的是十六进制指纹（`AA:BB:...`），
  curl 的 `--pinnedpubkey` 需要 base64，转换一下：

```bash
# 假设设置页显示 81:62:2A:EF:...:79
HEX="81:62:2A:EF:9B:A0:CC:01:89:B8:D0:0B:1A:AC:1D:83:54:2D:FF:A4:5F:E8:66:6C:8E:19:02:D2:57:07:3E:79"
B64=$(echo -n "$HEX" | tr -d ':' | xxd -r -p | base64)

curl --pinnedpubkey "sha256//$B64" https://192.168.1.30:15320/api/v1/health
```

Node.js 里可以用 `checkServerIdentity` 或 `tls` 的 `ca` 选项做等效校验。

### 鉴权

除 `/api/v1/health` 外，**所有接口都需要密钥**，三种方式任选：

| 方式 | 示例 | 适用场景 |
| --- | --- | --- |
| 请求头（推荐） | `X-API-Key: <密钥>` | 所有程序调用 |
| Bearer | `Authorization: Bearer <密钥>` | 习惯 OAuth 风格的工具 |
| 查询参数 | `?apiKey=<密钥>` | **浏览器的 EventSource**（它无法自定义请求头） |

密钥缺失或错误统一返回 `401`，不做区分（防止枚举）。
同一 IP 一分钟内失败 20 次会被临时拒绝（`429`）。

### 响应结构

成功（除截图接口外）：

```json
{ "data": <结果>, "requestId": "8ee6f341-..." }
```

失败：

```json
{
  "error": { "code": "BROWSER_NOT_FOUND", "message": "浏览器不存在: xxx", "details": null },
  "requestId": "8ee6f341-..."
}
```

- `requestId` 会同时通过 `X-Request-Id` 响应头返回，排障时用它去查服务端日志
- 截图接口成功时**直接返回图片二进制**，不走上面的信封（见该接口说明）

### 错误码全表

| code | HTTP | 含义 | 怎么处理 |
| --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | 密钥缺失或错误 | 检查密钥 |
| `NOT_ENABLED` | 404 | 远程 API 未开启 | 去设置页开启（用 404 而非 403 是为了不暴露存在性） |
| `INVALID_ARGUMENT` | 400 | 参数不合法 | 按 `message` 修正 |
| `INVALID_JSON` | 400 | 请求体不是合法 JSON | 检查序列化 |
| `UNKNOWN_FIELD` | 400 | 传了不支持的字段 | 见各接口的字段表，`cachePath`/`uid`/`type` 是**故意禁止**的 |
| `PARENT_NOT_FOUND` | 422 | 父文件夹不存在 | 用 `GET /browsers` 查可用的 `parentUid` |
| `UNKNOWN_AUTOMATION_SCRIPT` | 422 | 自动化程序名不存在 | 用 `GET /automation-scripts` 查可用名单 |
| `EXECUTABLE_PATH_NOT_SET` | 412 | 服务端还没配置浏览器路径 | 需要在软件设置里配置，调用方无法解决 |
| `BROWSER_NOT_FOUND` | 404 | 浏览器 uid 不存在 | 重新查询 |
| `TASK_NOT_FOUND` | 404 | 任务不存在 | 任务表不持久化，应用重启后需用 `clientToken` 反查 |
| `PAGE_NOT_FOUND` | 404 | 指定的页面 URL 片段没有匹配 | `message` 里会列出当前可用的页面 URL |
| `NOT_RUNNING` | 409 | 浏览器未在运行 | 截图/关闭一个没启动的浏览器会得到这个 |
| `NO_PAGE` | 409 | 浏览器一个页面都没有 | 通常是刚启动还没加载完 |
| `ALREADY_RUNNING` | 409 | 该浏览器已在运行或正在启动 | 先查状态，别重复启动 |
| `BROWSER_BUSY` | 409 | 该浏览器有进行中的任务 | 等上一个任务结束 |
| `LAUNCH_FAILED` | 500 | 启动流程走完了但没进入运行状态 | 多半是浏览器本身起不来（版本过高、路径失效），查软件内提示 |
| `LAUNCH_TIMEOUT` | 504 | 启动超时 | **结果未知**，先查状态再决定是否重试 |
| `CLOSE_TIMEOUT` | 504 | 关闭超时 | 同上 |
| `WORKER_TIMEOUT` | 504 | 子进程未在超时内响应 | 稍后重试 |
| `WORKER_ERROR` | 500 | 子进程执行出错 | 看 `message` |
| `RENDERER_UNAVAILABLE` | 503 | 渲染进程未就绪或刚重载 | 等几秒重试 |
| `INTERNAL` | 500 | 未分类的服务端错误 | 带 `requestId` 查服务端日志 |

---

## 三、接口一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/health` | 健康检查（**唯一免鉴权**） |
| GET | `/api/v1/automation-scripts` | 列出可用自动化程序及其配置项 |
| POST | `/api/v1/browsers` | 创建浏览器 |
| GET | `/api/v1/browsers` | 列出浏览器 |
| GET | `/api/v1/browsers/:uid` | 查单个浏览器详情（含实时状态） |
| POST | `/api/v1/browsers/:uid/launch` | 启动浏览器（异步任务） |
| POST | `/api/v1/browsers/:uid/close` | 关闭浏览器（异步任务） |
| GET | `/api/v1/browsers/:uid/pages` | 列出该浏览器打开的标签页 |
| GET | `/api/v1/browsers/:uid/screenshot` | 截取页面画面 |
| GET | `/api/v1/tasks/:taskId` | 查询任务状态 |
| GET | `/api/v1/events` | **SSE 事件流**（状态与任务实时推送） |

---

## 四、接口详解

### GET /api/v1/health

健康检查，**不需要密钥**。

**响应**

| 字段 | 说明 |
| --- | --- |
| `ok` | 恒为 `true`（能返回就说明服务活着） |
| `version` | 应用版本号 |
| `panel.enabled` | 远程 API 是否已开启 |
| `panel.hasKey` | 是否已配置密钥 |
| `listening` | HTTPS 服务是否在监听 |
| `rendererReady` | **渲染进程是否就绪**。为 `false` 时其他接口会返回 503 |
| `certFingerprint` | 自签证书 SHA-256 指纹，用于证书固定 |
| `addresses` | 本机可用于访问的 IP 列表 |

**这是排查问题的第一站**：先看它，再调其他接口。

---

### GET /api/v1/automation-scripts

列出内置的自动化程序及其**配置项 schema**。创建浏览器时如果需要带自动化程序，
先用这个接口查清楚有哪些、需要填哪些 key。

**响应**

```json
{
  "data": {
    "scripts": [
      {
        "name": "超星-手机密码登录",
        "icon": "https://www.chaoxing.com/",
        "configs": {
          "phone": { "label": "手机号", "value": "", "type": "text", "required": true, "placeholder": "请输入手机号" },
          "password": { "label": "密码", "value": "", "type": "password", "required": true, "placeholder": "请输入密码" }
        }
      }
    ],
    "total": 6
  }
}
```

`configs` 里每个键就是创建时 `configs` 对象能填的字段名；`value` 是默认值。

---

### POST /api/v1/browsers

创建一个浏览器实例。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 否 | 名称，1-64 字符。不传自动生成"未命名浏览器"（同名会自动加序号） |
| `parentUid` | string | 否 | 放在哪个文件夹下。传 `"root"` 或省略表示根目录 |
| `clientToken` | string | 否 | **幂等键**，8-128 字符（`A-Za-z0-9._:-`）。见下方说明 |
| `notes` | string | 否 | 备注，≤2000 字符 |
| `tags` | array | 否 | `[{ "name": "标签名", "color": "#165dff" }]`，最多 20 个 |
| `automationScripts` | array | 否 | `[{ "name": "脚本名", "configs": { "键": 值 } }]`，最多 50 个 |

**明确禁止的字段**（传了会返回 `400 UNKNOWN_FIELD`）：

- `cachePath` —— 它会进 Chromium 的 `--user-data-dir`，而删除浏览器时会对其递归删除，
  允许外部指定等于给出"删任意目录"的破坏链
- `uid` / `type` —— 由服务端决定

**关于 `clientToken`（幂等键）**

同一个 `clientToken` 重复创建**只会得到同一个浏览器**，返回 `200` + `created: false`。
这是为了应对网络超时后的重试——因为**没有删除接口**，重复创建会在浏览器树里留下永久垃圾。

强烈建议：**只要会重试，就一定带上它**。

**关于 `configs`**

只需提供「键 → 值」，服务端的元数据（label / type / required）会自动从脚本声明里补齐：

```json
{
  "name": "我的浏览器",
  "clientToken": "order-20260913-001",
  "notes": "由订单系统创建",
  "tags": [{ "name": "自动", "color": "#165dff" }],
  "automationScripts": [
    {
      "name": "超星-手机密码登录",
      "configs": { "phone": "13800000000", "password": "xxxxxx" }
    }
  ]
}
```

**响应**

- `201` —— 新建成功
- `200` —— 幂等命中，浏览器已存在

```json
{
  "data": {
    "created": true,
    "browser": {
      "uid": "b2976b101d7945f28a9419e7c2d14ab6",
      "name": "我的浏览器",
      "parentUid": "root-folder",
      "notes": "由订单系统创建",
      "tags": [{ "name": "自动", "color": "#165dff" }],
      "cachePath": "/home/user/.config/OCS Desktop/userDataDirs/b2976b...",
      "createTime": 1789107118635,
      "automationScripts": [
        {
          "name": "超星-手机密码登录",
          "configs": {
            "phone": { "label": "手机号", "value": "13800000000", "type": "text", "required": true, "placeholder": "请输入手机号" },
            "password": { "label": "密码", "value": "xxxxxx", "type": "password", "required": true, "placeholder": "请输入密码" }
          }
        }
      ],
      "status": "closed",
      "remoteMeta": { "clientToken": "order-20260913-001", "source": "remote", "createdAt": 1789107118635 }
    }
  },
  "requestId": "..."
}
```

创建后会**立即落盘**，响应返回时数据已经写入磁盘。

---

### GET /api/v1/browsers

列出浏览器。

**查询参数**

| 参数 | 说明 |
| --- | --- |
| `parentUid` | 只列某个文件夹下的 |
| `clientToken` | **只列某个 token 创建的**。应用重启后靠它反查自己创建过的实例 |
| `running` | `true` 只列运行中的，`false` 只列未运行的 |

**响应**

```json
{ "data": { "browsers": [ ... ], "total": 2 }, "requestId": "..." }
```

数组元素结构与创建接口返回的 `browser` 一致。

> ⚠️ **注意：响应的 `automationScripts[].configs` 里包含明文账号密码。**
> 这是当前的已知问题，尚未处理。如果你会记录调用日志，请自行过滤这个字段。

---

### GET /api/v1/browsers/:uid

查单个浏览器的详情，**`status` 是实时值**。

**`status` 取值**

| 值 | 含义 |
| --- | --- |
| `closed` | 未运行 |
| `launching` | 正在启动（含安装用户脚本，可能持续数分钟） |
| `launched` | 运行中 |
| `closing` | 正在关闭 |
| `orphaned` | **进程可能还在跑，但软件已失去对它的控制** |

**关于 `orphaned`**：渲染进程重载（崩溃恢复、手动刷新）会清空它内部的进程表，
但浏览器子进程仍在运行。此时接口会如实报 `orphaned` 而不是谎报 `closed`——
因为谎报 `closed` 会让调用方以为可以重新启动，而实际上 Chromium 的
profile 锁会让新实例起不来。

遇到 `orphaned` 的实例，需要人工在图形界面里关闭它，或者重启应用。

---

### POST /api/v1/browsers/:uid/launch

启动浏览器。**这是异步接口**，立刻返回任务 ID。

**响应 `202`**

```json
{ "data": { "taskId": "7e2274a4-2ec0-429c-913c-1f2e37883114", "uid": "...", "state": "running" }, "requestId": "..." }
```

拿到 `taskId` 后轮询 `GET /api/v1/tasks/:taskId`（或直接用 SSE 事件流）。

**同步前置检查**：接口在返回 `202` 之前会先检查，能立刻失败的情况不会拖到任务里：

| 情况 | 响应 |
| --- | --- |
| 浏览器不存在 | `404 BROWSER_NOT_FOUND` |
| 已经在运行/启动中 | `409 ALREADY_RUNNING` |
| 该浏览器已有进行中的任务 | `409 BROWSER_BUSY` |

**启动耗时说明**：正常情况下十几秒。如果浏览器配置了用户脚本需要安装，
每个脚本最长等待 120 秒，多个脚本会叠加。**服务端默认超时 10 分钟**。

---

### POST /api/v1/browsers/:uid/close

关闭浏览器。同样是异步任务，响应格式与 `launch` 一致。

未运行时返回 `409 NOT_RUNNING`。

---

### GET /api/v1/browsers/:uid/pages

列出该浏览器当前打开的所有标签页。

**响应**

```json
{
  "data": {
    "pages": [
      { "index": 0, "url": "http://localhost:15319/index.html#/bookmarks?uid=xxx", "title": "OCS - 导航页" },
      { "index": 1, "url": "https://passport2.chaoxing.com/login", "title": "登录" }
    ]
  },
  "requestId": "..."
}
```

浏览器未运行时返回 `409 NOT_RUNNING`。

**用途**：截图接口的 `page` 参数需要一个 URL 片段，先用这个接口看看有哪些页面。

> 书签导航页是 `index: 0`；自动化脚本打开的业务页面在后面。

---

### GET /api/v1/browsers/:uid/screenshot

截取页面画面。

**查询参数**

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `page` | 最后一个页面 | 目标页的 **URL 片段**（子串匹配）。找不到会返回 `404 PAGE_NOT_FOUND` 并列出可用页面 |
| `format` | `jpeg` | `jpeg` 或 `png` |
| `quality` | `70` | 0-100，**仅 jpeg 有效** |
| `fullPage` | `false` | `true` 截整页（含滚动区域），`false` 只截可视区域 |

**响应**

成功时返回**图片二进制**，`Content-Type` 为 `image/jpeg` 或 `image/png`：

| 响应头 | 说明 |
| --- | --- |
| `X-Page-Url` | 实际截到的那一页的 URL（**URL 编码**，需解码） |
| `X-Page-Title` | 该页标题（**URL 编码**，需解码） |
| `Content-Length` | 图片字节数 |

失败时返回标准 JSON 错误体。

> 之所以返回二进制而不是 base64 放进 JSON：这样才能直接丢进 `<img src>` 或存成文件用图片查看器打开。

**尺寸参考**：1280×720 视口下，JPEG(70) 约 50KB，PNG 整页约 470KB。

**关于截图目标**：截的是**页面内容本身**，不是操作系统窗口。
所以浏览器窗口被最小化、被其他窗口遮挡时依然能截到——这对服务端无人值守场景很重要。

---

### GET /api/v1/tasks/:taskId

查询异步任务的状态。

**查询参数**

| 参数 | 说明 |
| --- | --- |
| `wait` | 最长阻塞等待秒数，上限 60。不传则立即返回 |

`?wait=30` 可以实现"一次请求拿到结果"，不必自己写轮询循环。

**响应**

```json
{
  "data": {
    "taskId": "7e2274a4-...",
    "kind": "launch",
    "uid": "b2976b10...",
    "state": "succeeded",
    "phase": "launched",
    "message": "浏览器已启动",
    "createdAt": 1789108525099,
    "startedAt": 1789108525099,
    "finishedAt": 1789108538120,
    "error": null,
    "result": { "uid": "b2976b10...", "status": "launched" }
  },
  "requestId": "..."
}
```

**`state` 取值**

| 值 | 含义 | 调用方该做什么 |
| --- | --- | --- |
| `queued` | 排队中（并发超过上限） | 继续等 |
| `running` | 执行中 | 继续等 |
| `succeeded` | 成功 | 完成 |
| `failed` | 失败 | 看 `error.code`，**不要盲目重试** |
| `timeout` | **超时，结果未知** | **先查状态，再决定** |
| `unknown` | 结果未知（渲染进程崩溃等） | 先查状态 |

**`phase` 取值**（阶段，比 `state` 细）

`queued` / `precheck` / `launching` / `launched` / `closing` / `closed`

> 代码里还预留了 `checking-scripts` / `installing-scripts`，目前不会发出。

**⚠️ 超时（`timeout` / 504）不等于失败**：

超时那一刻浏览器**可能真的已经起来了**，只是 `launched` 事件没等到、或还卡在安装脚本。
此时若重试启动，会撞上 Chromium 的 profile 锁导致新实例起不来。
**正确做法是先 `GET /api/v1/browsers/:uid` 看实际状态。**

**任务表不持久化**：应用重启后旧 `taskId` 会返回 `404 TASK_NOT_FOUND`。
需要跨重启追溯时，用创建时的 `clientToken` 调 `GET /api/v1/browsers?clientToken=`。

---

### GET /api/v1/events

**SSE（Server-Sent Events）事件流**，浏览器状态与任务状态变化时服务端主动推送，
不需要轮询。

```bash
curl -k -N -H "X-API-Key: $KEY" https://192.168.1.30:15320/api/v1/events
```

```javascript
// 浏览器里（EventSource 无法设自定义头，所以密钥走查询参数）
const es = new EventSource(`https://192.168.1.30:15320/api/v1/events?apiKey=${KEY}`);
es.addEventListener('status', (e) => console.log('状态变化', JSON.parse(e.data)));
es.addEventListener('task', (e) => console.log('任务变化', JSON.parse(e.data)));
```

与服务端每 **25 秒**发一次心跳（SSE 注释行，客户端会忽略），用于保活。

#### 事件类型

| event | 触发时机 | data |
| --- | --- | --- |
| `ready` | 连接建立 | `{ requestId }` |
| `status` | 浏览器运行状态变化 | `{ uid, status }` |
| `task` | 任务创建/阶段推进/终结 | 同 `GET /tasks/:taskId` 的 data |

#### `status` 事件

```json
{ "uid": "b2976b10...", "status": "launched" }
```

`status` 取值与 `GET /browsers/:uid` 一致：`launching` / `launched` / `closing` / `closed` / `orphaned`。

只在**真正变化时**推送，不会重复刷同样的值。

#### `task` 事件

```json
{ "taskId": "7e2274a4-...", "kind": "launch", "uid": "b2976b10...", "state": "running", "phase": "precheck", "message": "正在检查浏览器路径与用户脚本" }
```

一次启动的完整事件序列大致是：

```
task  state=running   phase=precheck
task  state=running   phase=precheck   message=正在检查浏览器路径与用户脚本
status                          status=launching
status                          status=launched
task  state=running   phase=launched   message=浏览器已启动
task  state=succeeded phase=launched   message=浏览器已启动
```

---

## 五、典型调用流程

### 场景：创建并启动一个浏览器

```bash
KEY=你的密钥
BASE=https://192.168.1.30:15320
AUTH="-H 'X-API-Key: $KEY'"

# 1. 看看有哪些自动化程序可选（可选）
curl -k -H "X-API-Key: $KEY" $BASE/api/v1/automation-scripts

# 2. 创建（用幂等键，重试安全）
curl -k -X POST $BASE/api/v1/browsers \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
        "name": "订单-20260913-001",
        "clientToken": "order-20260913-001",
        "automationScripts": [
          { "name": "超星-手机密码登录", "configs": { "phone": "13800000000", "password": "xxxxxx" } }
        ]
      }'
# 记下返回的 uid

# 3. 启动
curl -k -X POST $BASE/api/v1/browsers/<uid>/launch -H "X-API-Key: $KEY"
# 记下返回的 taskId

# 4. 等任务结束（一次阻塞 60 秒，不够就再等一轮）
curl -k -H "X-API-Key: $KEY" "$BASE/api/v1/tasks/<taskId>?wait=60"

# 5. 确认状态
curl -k -H "X-API-Key: $KEY" $BASE/api/v1/browsers/<uid>

# 6. 看看它现在停在哪个页面
curl -k -H "X-API-Key: $KEY" $BASE/api/v1/browsers/<uid>/pages

# 7. 截图确认
curl -k -H "X-API-Key: $KEY" -o shot.jpg $BASE/api/v1/browsers/<uid>/screenshot

# 8. 用完关闭
curl -k -X POST $BASE/api/v1/browsers/<uid>/close -H "X-API-Key: $KEY"
```

### 场景：用 SSE 实时监控（Node.js）

```javascript
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 或改用证书固定

const KEY = '你的密钥';
const BASE = 'https://192.168.1.30:15320';

const res = await fetch(`${BASE}/api/v1/events`, { headers: { 'X-API-Key': KEY } });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';

for (;;) {
	const { done, value } = await reader.read();
	if (done) break;
	buf += decoder.decode(value, { stream: true });
	let i;
	while ((i = buf.indexOf('\n\n')) !== -1) {
		const chunk = buf.slice(0, i);
		buf = buf.slice(i + 2);
		const event = (chunk.match(/^event: (.+)$/m) || [])[1];
		const data = (chunk.match(/^data: (.+)$/m) || [])[1];
		if (event && data) console.log(event, JSON.parse(data));
	}
}
```

---

## 六、注意事项与限制

### 安全

- **仅限可信内网**。密钥是 bearer token 形式，能拿到它的人就能在你的机器上拉起浏览器进程
- 走 HTTPS 自签证书，**建议固定证书指纹**而不是简单关闭校验
- 调用日志里**不要记录 `automationScripts` 字段**——里面有明文账号密码

### 能力边界

- **没有删除接口**。调用方创建出来的浏览器只能人工在图形界面里删。
  因此**务必使用 `clientToken`**，避免重试造成永久垃圾
- **没有远程操作接口**（点击/输入/导航）。如需，将来会以
  `POST /api/v1/browsers/:uid/actions` 的形式提供，与现有接口风格一致
- **没有连续画面**。截图是"拉一张是一张"，需要连续画面时由调用方自行控制频率

### 性能与限制

- 服务端同时只处理 **3 个**渲染侧请求（含截图）。
  高频轮询截图会挤占其他接口，建议间隔不低于 1 秒
- 请求体上限 256KB
- 同一 IP 一分钟内鉴权失败 20 次会被临时拒绝
- 任务表最多保留 1000 条 / 终态 30 分钟，超出会淘汰

### 状态语义

- `orphaned` 表示**进程可能还在跑但软件已失去控制**，需要人工处理
- 任务 `timeout` 表示**结果未知**，不等于失败——先查状态再决定是否重试
