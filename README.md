# 桌宠 Desktop Pet

一只住在 Windows 桌面上的 2D 桌宠，基于 GitHub Copilot App 扩展实现。
透明置顶悬浮窗、会自己走动、可拖拽、戳一戳会说话，还会跟着 Copilot 会话联动——
**你在写代码，它在旁边敲电脑；你干完活，它复盘并冒泡汇报。**

## 功能

- 🖥️ 真·桌面悬浮窗（WPF 透明置顶）：走动 / 睡觉 / 跳跃 / 挥手 / 工作 / 思考 / 复盘
- 💬 戳一戳随机冒泡说话；agent 可让桌宠说任意内容
- 🗨️ **右键「聊天…」**：直接在桌宠气泡里跟 Copilot 对话，不用切窗口
- 👀 **右键「看着对话框」**：桌宠实时转头看向 Copilot 对话框窗口（左右转头 / 抬头低头 / 镜像翻转）
- 🔗 会话联动：agent 跑工具时坐下敲电脑（🛠），**模型推理时换「思考中」动画（💭）**，
  任务完成自动复盘汇报
- 🎬 收场动画分得清：**主动结束（你点了停止）**演 `aborted`，**异常结束（会话报错）**演 `error`，
  正常完成演 `review`；拖拽 / 戳 / 聊天 / 看对话框各有专属动画
- ⚡ 低延迟：会话事件（含 `session.idle`）直接推给桌宠，叠加 SSE 推送，收工/开工几乎无感延迟
- 🌐 跨会话感知：任意一个 Copilot 会话在工作，桌宠都知道（心跳注册表 + 事件日志双重检测）
- 🩹 崩溃自愈：扩展异常不再静默退出，先演一段 `error`（回退 `failed`）动画再自愈；桌面窗连不上扩展也不再自杀
- 🔌 外部事件监听（可选）：不开 Copilot 也能用本机 HTTP 推送 working/idle，桌宠照样联动
- 🚀 打开 Copilot 自动召唤（`autoStart`）
- 🎛️ 画布面板：预览动画、选动画、开关「看对话框」、召唤 / 收回桌宠、一键打开桌宠库文件夹
- 🎨 配置驱动换装：一张 spritesheet + 一个 `pet.json` 就是一只新桌宠

## 安装

1. 把本仓库全部文件复制到项目的 `.github/extensions/desktop-pet/` 目录下
2. 可直接使用内置 Octocat；自定义桌宠时复制 `pet.example.json` 为 `pet.json`，按下面「配置」一节修改
3. 自定义桌宠需放入对应贴图；请保留仓库的 `assets/` 目录和所有脚本文件
4. 在 Copilot App 中重载扩展，打开「桌宠」画布，点「召唤桌宠」

## 使用

直接对 Copilot 说：

- 「召唤桌宠」/「收回桌宠」
- 「让桌宠说：……」
- 「让桌宠播 xxx 动画」/「恢复自动行为」
- 「让桌宠看着对话框」/「别看了」（`desktop_pet_look_at_copilot`）
- 「打开桌宠库文件夹」/「打开桌宠文件夹」

手动启动：**双击 `start-pet.bat`**（或 `powershell -File start-pet.ps1`）。
脚本会自动判断：已经在跑就提示不重复召唤；有 Copilot 会话加载了扩展就让该实例召唤
（联动会话状态）；都没有则独立模式直接拉起 `pet-window.ps1`——独立模式同样联动：
本地检测 GitHub Copilot App 是否运行，并读取各会话 `events.jsonl` 的近期写入判断 working/idle
（与扩展的事件日志兜底同口径，见下文「状态判定原理」第 3 条）。

桌面上：

- 左键拖拽移动（拖拽时演 `drag`）；单击（不拖动）戳一戳说话并演 `poke`
- 右键菜单：
  - **聊天…**：弹出桌宠聊天窗，输入的话会发给当前 Copilot 会话，回复显示在气泡里
  - **看着对话框 开/关**：桌宠实时转头看向 Copilot 对话框窗口（找不到窗口时保持默认朝向，窗口出现后自动跟上）
  - **打开桌宠库文件夹**：在资源管理器里打开 `%APPDATA%\copilot-desktop-pet\pets`
  - **动画 ▸**：手动指定播放某个动画（含「自动」恢复自动行为）
  - **打开设置**：独立的 Windows 原生窗口，支持预览 / 切换 / 导入 / 保存 / 删除；独立模式也可用
  - 开关自动走动、让它睡觉、退出

### 跟桌宠聊天

右键桌宠 →「聊天…」，或 `POST /api/chat`。聊天把消息**发给当前前台 Copilot 会话**，
回复由桌宠说出来（气泡只显示摘要，超过 160 字会截断加省略号）：

- 提示词带人设（`chat.persona`，`{name}` 会替换成桌宠名），并明确要求**不要调用工具、不要改文件**，
  所以聊天不会把编码会话带偏
- 上一条还没回完时再发会得到 429（桌宠一次只想一件事）
- 拿不到回复 / 会话报错时，冒泡 `chat.offlineReplies` 里的离线台词兜底
- 超时、长度上限由 `chat.timeoutMs` / `chat.maxChars` 控制

### 桌宠库（多桌宠切换）

面板顶部点「切换桌宠」，或桌面右键「打开设置」：

- **保存当前桌宠**：把当前 `pet.json` + 贴图保存到用户数据目录中的 `pets/<uuid>/`
- **导入桌宠**：选一份配置 JSON + 对应的 spritesheet 图片（支持外部工具生成的
  `cell`/`row_counts` 记录格式，导入时自动归一化成 `frameWidth`/`frameHeight`/`animations`）
- **选择顺序不限**：先选图片或先选 JSON 都可以；原生设置中选齐后点「导入并切换」，画布面板选齐后自动导入
- **预览**：原生设置选择库内桌宠即可预览；画布库每只桌宠显示动画缩略图，导入后立即刷新
- **删除**：确认后删除库内配置和贴图；删除当前桌宠时先切换到另一只，最后一只当前桌宠不能删除
- **切换**：点库里的任意桌宠立即换装（更新用户数据目录中的活动配置，桌面窗热更新）
- **默认桌宠**：首次安装内置 Octocat 章鱼猫；已有配置保留。默认素材为 GitHub Octodex 原图，单帧显示，走动和注视通过位移/镜像实现（素材来源及使用说明见 `assets/README.md`）

桌宠配置和库数据存放在 `%APPDATA%\\copilot-desktop-pet\\`（包括 `pet.json`、`pets/`）。首次启动时会从扩展目录复制旧版 `pet.json`；不会把导入的贴图复制进扩展，因此宠物库不会占用 Copilot 扩展的 8 MiB 安装限额。原有扩展目录中的贴图仍可作为当前桌宠的回退来源。

可直接运行 `powershell -NoProfile -STA -ExecutionPolicy Bypass -File pet-settings.ps1` 打开设置。

对应 HTTP API：`GET /api/pets`、`POST /api/pets/save` / `/api/pets/import` / `/api/pets/activate` / `/api/pets/delete`（删除请求体为 `{ "id": "UUID" }`；最后一只当前桌宠返回 409）。

扩展的 HTTP 服务默认固定监听 **10405** 端口（被占用时退回随机端口），
外部工具可以按固定端口直接找到它；`PET_HTTP_PORT` 环境变量仍可覆盖。

### 外部事件监听（不装 Copilot 也能联动）

默认关闭。在 `pet.json` 里打开：

```json
"externalEvents": { "enabled": true, "port": 0, "token": "可选的口令" }
```

之后任何本机程序都能直接驱动桌宠（`port: 0` 表示跟随扩展主服务端口）：

```powershell
# 找到端口：%TEMP%\copilot-desktop-pet\inst-<pid>.json 里的 url 字段，或 GET /api/sessions，或固定 PET_HTTP_PORT
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:38888/api/working" -ContentType "application/json" -Body "{}"
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:38888/api/idle"    -ContentType "application/json" -Body "{}"
```

- 配了 `token` 就必须带上 `X-Pet-Token: <token>`（或 `?token=<token>`），否则 401
- 没开启 `externalEvents` 时这两个端点返回 403
- 配合只用 `pet-window.ps1` 启动的场景：写个几行的循环脚本，在外部程序开始时 POST `/api/working`、结束时 POST `/api/idle`，桌宠就会跟着敲电脑 / 复盘

## 配置（pet.json）

`pet.json` 是桌宠的全部定义，**改完无需重启**，桌面窗和面板几秒内自动热更新。

推荐从原生设置的「编辑当前配置」打开 `%APPDATA%\copilot-desktop-pet\pet.json`。
旧扩展目录的 `pet.json` 和当前激活的 `pets/<uuid>/pet.json` 修改也会同步到工作副本，重启后同样生效。
来源按内容哈希记录：未修改的旧配置不会覆盖当前桌宠或工作副本；同时改动旧目录和活动库时，旧目录修改优先并清除活动库标记。
无效 JSON 保留上一份有效配置，修正后自动重试。`autoStart` 与外部监听端口属于启动参数，需要重载扩展。

「看着对话框」通过窗口进程名/产品信息定位 GitHub Copilot，不依赖会话标题。
可见且未最小化的窗口中优先前台实例；浏览器/终端里带 Copilot 的标题不会被选中。
Windows UI Automation 能读取输入框时朝输入框中心看；应用未暴露该控件时朝窗口下方输入区域看。
没有可见窗口时保持默认朝向，窗口恢复后继续跟随；不需要 Copilot SDK 提供窗口定位接口。

### 完整示例

```json
{
  "name": "Claye",
  "autoStart": true,
  "sprite": "claye-spritesheet.png",
  "frameWidth": 192,
  "frameHeight": 208,
  "scale": 1,
  "fps": 8,
  "defaultAnimation": "idle",
  "animations": {
    "idle":    { "row": 0, "frames": 6 },
    "walk":    { "row": 1, "leftRow": 2, "frames": 8 },
    "waving":  { "row": 3, "frames": 4 },
    "jumping": { "row": 4, "frames": 5 },
    "failed":  { "row": 5, "frames": 8 },
    "sleep":   { "row": 6, "frames": 6 },
    "work":    { "row": 7, "frames": 6 },
    "review":  { "row": 8, "frames": 6 },
    "thinking":{ "row": 9, "frames": 6 },
    "chat":    { "row": 10, "frames": 4 },
    "look":    { "row": 11, "frames": 4 },
    "drag":    { "row": 12, "frames": 2 },
    "poke":    { "row": 13, "frames": 2 },
    "aborted": { "row": 14, "frames": 3 }
  },
  "behavior": {
    "autoWander": true,
    "walkSpeedPxPerSec": 60,
    "wanderIntervalSec": [4, 9],
    "sleepAfterIdleSec": 40,
    "lookAtCopilot": false
  },
  "speech": {
    "phrases": ["……什么事？", "嗯，我在。", "别戳了。"],
    "fontSize": 13
  },
  "chat": {
    "persona": "你是桌宠「{name}」，回答简短可爱，不要调用任何工具。",
    "timeoutMs": 60000,
    "maxChars": 2000,
    "offlineReplies": ["我现在连不上大脑，先陪我待会儿吧。"]
  }
}
```

### 顶层字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `name` | string | `"Copilot 桌宠"` | 桌宠名字（面板标题等） |
| `autoStart` | bool | `false` | 打开 Copilot 时自动召唤桌宠（多会话同时开也不会重复召唤） |
| `sprite` | string | `"spritesheet.png"` | 贴图文件名，与 pet.json 同目录，支持 png/gif/webp |
| `frameWidth` / `frameHeight` | number | 32 | 单帧像素尺寸 |
| `scale` | number | 4 | 正数缩放倍数，支持小数（像素风小贴图建议 3~4；大贴图可设 1 或更小） |
| `fps` | number | 8 | 全局帧率 |
| `defaultAnimation` | string | `"idle"` | 待机时播放的动画名 |
| `pollIntervalMs` | number | 250 | 桌宠窗口/面板拉取状态的间隔（毫秒，100~5000）。SSE 可用时基本走推送，这个值只作为兜底 |
| `externalEvents` | object | 见下 | 外部事件监听（不开 Copilot 也能驱动桌宠） |

### animations（动画表）

贴图按**等宽帧网格**切分：一行一个动画，帧从左到右排列。

| 字段 | 必填 | 说明 |
|---|---|---|
| `row` | ✅ | 该动画在贴图中的行号（从 0 开始） |
| `frames` | ✅ | 该动画的帧数 |
| `fps` | 可选 | 覆盖全局帧率 |
| `leftRow` | 可选 | 向左走时使用的行号。**方向烘焙在贴图里**（左右不对称的角色，如单手抱笔记本）时用此字段分行；不设则向左走时自动镜像翻转 `row` |

### 特殊动画名（有行为联动）

| 动画名 | 触发时机 |
|---|---|
| `idle` | 待机（也用作 `defaultAnimation` 的回退） |
| `walk` | 自主走动时 |
| `sleep` | 长时间无交互自动入睡 |
| `thinking` | **agent 在推理/思考**（收到消息、回合开始、`assistant.reasoning` 等，还没开始跑工具） |
| `work` | **任意会话的 agent 正在跑工具时** |
| `chat` | 正在跟桌宠聊天（等回复期间） |
| `look` | 开启「看着对话框」并且找得到 Copilot 对话框窗口时 |
| `drag` | 正在被拖动 |
| `poke` | 刚被戳了一下（约 1.2 秒） |
| `review` | 一次任务**正常跑完**（`session.idle` 且非主动中止），自动演 6 秒 |
| `aborted` | **主动结束**（点了停止，`session.idle` 带 `aborted`），自动演 5 秒 |
| `error` | **异常结束**（`session.error`，或扩展崩溃），自动演 6 秒 |
| 其他任意名 | 可通过 `desktop_pet_set_animation` 工具、画布动作或右键「动画 ▸」手动播放 |

#### 别名与优先级

每个行为都有别名，配置里**不用**非得起 `thinking` / `work` 这种名字——只要动画名命中
任一别名即可（例如 `busy` 当 `work` 用、`failed` 当 `error` 用）。
判定优先级（高到低）：

```
手动指定（override）> drag > poke > thinking > work > chat > look > sleep > walk
> defaultAnimation > idle
```

### behavior（行为）

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoWander` | true | 是否自主走动 |
| `walkSpeedPxPerSec` | 40 | 走动速度（像素/秒） |
| `wanderIntervalSec` | `[3, 8]` | 行为切换间隔 `[最小, 最大]` 秒 |
| `sleepAfterIdleSec` | 45 | 无交互多少秒后睡觉（0 = 不睡） |
| `lookAtCopilot` | false | 是否让桌宠实时看着 Copilot 对话框窗口（也可用右键菜单或面板复选框随时切换） |

### externalEvents（外部事件）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | false | 是否允许外部通过本机 HTTP 推送工作状态 |
| `port` | 0 | 期望的监听端口，0 = 跟随扩展主服务端口 |
| `token` | `""` | 非空时所有外部推送都要带 `X-Pet-Token` 头或 `?token=` 校验 |

### speech（台词）

| 字段 | 说明 |
|---|---|
| `phrases` | 戳一戳时的随机台词数组 |
| `fontSize` | 气泡字号（默认 13） |

### chat（聊天）

右键「聊天…」或 `POST /api/chat` 时使用。

| 字段 | 默认 | 说明 |
|---|---|---|
| `persona` | 见下 | 发给 Copilot 的人设前缀，`{name}` 会替换成桌宠名字；留空用内置人设 |
| `timeoutMs` | 60000 | 等回复的超时（毫秒） |
| `maxChars` | 2000 | 单条输入的最大字符数，超出返回 400 |
| `offlineReplies` | `["我现在连不上大脑（Copilot 会话），先陪我待会儿吧。"]` | 拿不到回复 / 会话报错时的随机离线台词 |

内置人设大意：*「你是一只住在 Windows 桌面上的 2D 桌宠，名字叫「{name}」。用简短、可爱、口语化的中文回答，
控制在 80 字以内；不要调用任何工具，不要修改文件或执行命令，只是聊天。」*
——这条约束是为了防止聊天把编码会话带偏，不建议去掉。

## 自制贴图规范

- 等宽帧网格 PNG：行高 = `frameHeight`，每帧宽 = `frameWidth`，一行一个动画
- 透明背景效果最佳；桌面窗使用最近邻缩放，像素风不会被模糊
- 左右不对称的角色：左行帧单独画一行，用 `leftRow` 指向它
- 参考：`pet.example.json` 是 32×32、12 行（idle/walk/sleep/thinking/work/chat/look/drag/poke/review/aborted/error）的示例配置，
  多余的动画行没有对应贴图行也不会报错（回退到 `defaultAnimation`），可以按需删减

## 技术架构

```
extension.mjs    扩展入口：agent tools + 画布面板 + 本地 HTTP 服务
                 + 会话事件联动（毫秒级）+ SSE 推送 + 崩溃自愈
                 + 跨会话心跳注册表（%TEMP%\copilot-desktop-pet）+ 桌面窗进程管理
state.mjs        桌宠状态机与纯逻辑（可单测，无 IO）
pet-window.ps1   桌面悬浮窗本体（WPF 透明置顶窗，动画状态机，配置热重载，断连保活）
pet.html         画布面板：预览动画 + 选动画 + 看对话框开关 + 召唤/收回控制栏 + 打开桌宠库文件夹
pet.example.json 示例配置
tests/           零依赖测试（node --test）
```

### 本地 HTTP 接口

| 接口 | 说明 |
|---|---|
| `GET /api/state` | 当前状态 `{ animation, message, activity, activitySource, workPhase, lookAtCopilot, running, sessions, crashed, pollIntervalMs, externalEvents, pid }`（`workPhase` 为 `thinking` / `tool` / `null`） |
| `GET /api/events` | SSE 状态流（`event: state`），状态一变就推 |
| `GET /api/sessions` | 各会话心跳：pid、activity、桌宠 pid、服务端口 |
| `POST /api/say` / `POST /api/animation` / `POST /api/reload` | 说话 / 切动画 / 重载配置 |
| `POST /api/chat` | 跟桌宠聊天，`{ "text": "..." }`（也接受 `message`）。回复里带 `reply`；输入空 → 400，正在回 → 429，没有可用会话 → 503，超时/报错 → 504（三种失败都会冒泡离线台词） |
| `POST /api/look_at_copilot` | `{ "enabled": true/false }` 开关「看着对话框」；不传 `enabled` 则切换 |
| `POST /api/open_folder` | 在资源管理器中打开桌宠库文件夹（`%APPDATA%\copilot-desktop-pet\pets`，路径固定不接受外部输入），返回 `{ ok, path }` |
| `POST /api/pet/show` / `hide` / `toggle` | 召唤 / 收回 / 切换桌宠 |
| `GET /api/pets`；`POST /api/pets/save` / `import` / `activate` / `delete` | 桌宠库：列表（含预览帧信息）/ 保存当前 / 导入（JSON+贴图 base64）/ 切换 / 删除 |
| `POST /api/working` / `idle` / `activity` | 外部事件推送（需开启 `externalEvents`；`activity` 接受 `{ "activity": "working" \| "idle" }`） |

### 状态判定原理（依次命中即返回，`GET /api/state` 的 `activitySource` 会标明来源）

1. **本会话事件**（`source: self`）：扩展收到 `user.message` / `tool.execution_start` 等事件立刻置 working，
   同时按事件类型细分**工作阶段**（`workPhase`）：收到消息 / 回合开始 / 推理 / 工具跑完 → `thinking`（演 `thinking` 动画），
   工具开始执行 → `tool`（演 `work` 动画，头顶 🛠）；
   收到 `session.idle` 立刻置 idle——这条是权威的「收工」信号，并在 7 秒内抑制下面的兜底逻辑，
   避免事件日志仍在补写时把桌宠又拉回 working（这就是原来「延迟过大」的主因）。
   收工瞬间还会演收场动画：正常完成 `review`、**主动结束**（`data.aborted`）`aborted`、**异常结束**（`session.error`）`error`。
2. **心跳注册表**（`source: registry`）：加载了本扩展的会话每 3 秒向
   `%TEMP%\copilot-desktop-pet\inst-<pid>.json` 写一条心跳（activity、桌宠 pid、服务端口）；
   12 秒未更新或进程已退出即视为离线。`GET /api/sessions` 可查看各会话实时状态。
3. **事件日志兜底**（`source: events-log`）：没加载扩展的会话（比如工作树里、其他仓库里的会话），
   检查 `~/.copilot/session-state/<会话>/events.jsonl` 最近 6 秒内是否有写入——有就是在干活，
   所以其他会话跑任务时你的桌宠照样敲电脑。
   **独立模式**（无扩展实例、直接启动 `pet-window.ps1`）由桌面窗自己按同一口径检测：
   先确认 GitHub Copilot App 在本机运行（进程或会话状态目录存在），再扫描各会话 `events.jsonl`
   的近期写入，约 1 秒刷新一次 working/idle。
4. **外部推送**（`source: self`）：`POST /api/working` / `POST /api/idle`，见上文「外部事件监听」。

### 开发与测试

```powershell
npm test          # node --test tests/（零第三方依赖，Node 18+）
```

## 贡献

欢迎提交 Issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
