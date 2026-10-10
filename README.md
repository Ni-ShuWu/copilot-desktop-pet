# Copilot 桌宠

一只住在 Windows 桌面上的 2D 桌宠，通过 GitHub Copilot App 扩展与 Copilot 会话联动。它会在桌面走动、睡觉、回应点击，也能在你工作时敲电脑、完成后复盘。

> 桌面窗口使用 WPF 和 PowerShell；扩展入口使用 Node.js。桌宠不需要额外的 Node.js 运行时依赖。

## 功能一览

- 透明置顶桌面窗：走动、睡觉、思考、工作、复盘、错误等动画；可拖动、点击互动。
- Copilot 会话联动：区分模型思考与工具执行，也能感知其他会话；完成、中止和报错有不同的收场动画。
- 桌宠聊天、手动切换动画、让桌宠说话，以及实时看向 Copilot 对话框。
- 桌宠库：保存、导入、预览、切换和删除自定义桌宠。
- 本机 HTTP API、SSE 状态流和可选外部事件接口，方便其他本地程序联动。
- 支持自定义 spritesheet 与 `pet.json`，修改配置后自动热更新。

## 安装与启动

1. 将仓库完整复制到项目的 `.github/extensions/desktop-pet/` 目录。保留 `assets/` 和脚本文件。
2. 在 Copilot App 中重载扩展，然后打开「桌宠」画布并选择「召唤桌宠」。
3. 也可双击 `start-pet.bat` 启动。脚本会优先复用已运行的桌宠或已加载扩展的会话；否则以独立模式启动。

内置 Octocat 可直接使用。若要自定义，复制 `pet.example.json` 为 `pet.json`，并将配置所指的 spritesheet 放在配置文件旁。自定义贴图不要替换或删除 `assets/`。

独立打开设置窗口：

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\pet-settings.ps1
```

桌宠配置和用户桌宠库位于 `%APPDATA%\copilot-desktop-pet\`。扩展目录中的初始配置会在首次启动时复制到用户数据目录；导入的贴图存放在用户目录，不占扩展安装空间。

补充：若无法启动桌宠可在Copilot添加仓库，并在`"你仓库存储位置"\copilot-worktrees\copilot-desktop-pet`中新建`.github\extensions`后将本仓库全部文件复制到`.github\extensions\copilot-desktop-pet`目录下，重载扩展即可，这是因为工作区中没有该插件所导致`Copilot`无法信任该扩展

## 使用

### 桌宠桌面窗

- 左键拖动桌宠；单击可戳它并显示随机台词。
- 右键菜单可打开聊天、切换动画、开关自动走动、睡觉、看向 Copilot 对话框、打开设置或退出。
- 设置窗口可预览、编辑、导入、切换和删除桌宠。

### Copilot 工具

可直接对 Copilot 说「召唤桌宠」「收回桌宠」「让桌宠说：……」「让桌宠播某个动画」或「让桌宠看着对话框」。扩展提供的工具包括：

- `desktop_pet_show` / `desktop_pet_hide`：召唤或收回桌宠。
- `desktop_pet_say`：显示一段文字气泡。
- `desktop_pet_set_animation`：播放指定动画；传入 `auto` 恢复自动行为。
- `desktop_pet_look_at_copilot`：开启、关闭或切换看向对话框。
- `desktop_pet_reload`：重新读取配置。

### 和桌宠聊天

右键桌宠选择「聊天…」，或调用 `POST /api/chat`。消息会发给当前 Copilot 会话，回复由桌宠显示。聊天提示词要求不调用工具、不改文件，以免打断编码任务。单次聊天未完成时再次发送会返回 429；不可用、报错或超时时会使用离线台词。

## 自定义桌宠

配置文件是 `pet.json`。推荐从设置窗口打开当前配置。保存有效 JSON 后，桌面窗和面板会自动热更新；`autoStart` 和外部监听端口等启动参数需要重载扩展。

贴图按等宽帧网格切分：每行是一种动画，帧从左到右排列。透明 PNG 效果最佳；支持 PNG、GIF、WebP。像素风桌宠使用最近邻缩放。向左走默认镜像；若角色左右方向不对称，可在动画中配置 `leftRow` 指向专用左向帧行。

```json
{
  "name": "我的桌宠",
  "autoStart": false,
  "sprite": "spritesheet.png",
  "frameWidth": 32,
  "frameHeight": 32,
  "scale": 4,
  "fps": 8,
  "defaultAnimation": "idle",
  "animations": {
    "idle": { "row": 0, "frames": 4 },
    "walk": { "row": 1, "frames": 4 },
    "thinking": { "row": 3, "frames": 4 },
    "work": { "row": 4, "frames": 4 },
    "review": { "row": 9, "frames": 4 }
  },
  "behavior": {
    "autoWander": true,
    "walkSpeedPxPerSec": 40,
    "wanderIntervalSec": [3, 8],
    "sleepAfterIdleSec": 45,
    "lookAtCopilot": false
  },
  "speech": {
    "phrases": ["嗯，我在。", "戳我干嘛？"],
    "fontSize": 13
  },
  "chat": {
    "persona": "你是桌宠「{name}」，简短可爱地回答，不要调用工具。",
    "timeoutMs": 60000,
    "maxChars": 2000,
    "offlineReplies": ["我现在连不上大脑，先陪我待会儿吧。"]
  },
  "externalEvents": {
    "enabled": false,
    "port": 0,
    "token": ""
  }
}
```

### 常用配置项

| 字段 | 说明 |
|---|---|
| `name` | 桌宠名称。 |
| `autoStart` | 打开 Copilot 时自动召唤；默认 `false`。 |
| `sprite` | 与 `pet.json` 同目录的贴图文件名。 |
| `frameWidth` / `frameHeight` | 单帧宽高（像素）。 |
| `scale` / `fps` | 显示缩放和默认帧率。 |
| `defaultAnimation` | 待机动画名称。 |
| `pollIntervalMs` | 状态轮询间隔（毫秒，默认 250）；SSE 可用时主要作为兜底。 |
| `animations` | 动画名到贴图行号、帧数的映射；动画可单独设置 `fps`、`leftRow`。 |
| `behavior.autoWander` | 是否自动走动。 |
| `behavior.walkSpeedPxPerSec` | 每秒移动像素数。 |
| `behavior.wanderIntervalSec` | 自动行为切换的最短、最长间隔（秒）。 |
| `behavior.sleepAfterIdleSec` | 无交互后多久睡觉；设为 `0` 禁用自动睡眠。 |
| `behavior.lookAtCopilot` | 是否默认看向 Copilot 对话框。 |
| `speech.phrases` / `speech.fontSize` | 点击桌宠时的随机台词及气泡字号。 |
| `chat.persona` | 聊天人设；`{name}` 会替换为桌宠名字。 |
| `chat.timeoutMs` / `chat.maxChars` | 聊天超时时间和单条输入长度上限。 |
| `chat.offlineReplies` | 无法取得回复时显示的随机台词。 |
| `externalEvents` | 可选的本机外部工作状态推送设置，见下文。 |

常用动画名：`idle`、`walk`、`sleep`、`thinking`、`work`、`chat`、`look`、`drag`、`poke`、`review`、`aborted`、`error`。可自定义名称；名称与行为别名匹配时会自动用于对应场景。动画优先级大致为手动指定、拖动、点击、思考、工具工作、聊天、注视、睡眠、走动、待机。

「看着对话框」通过 Windows 窗口识别定位 Copilot，不依赖会话标题。若窗口不可见或最小化，桌宠保持默认朝向；窗口重新出现后会继续跟随。输入框可被 UI Automation 识别时会朝输入框看，否则朝窗口下方看。

## 本机 HTTP API

扩展默认监听本机回环地址，优先使用 **10405** 端口；占用时会退回随机端口。`PET_HTTP_PORT` 可覆盖端口。可从 `%TEMP%\copilot-desktop-pet\inst-<pid>.json` 的 `url` 字段或 `GET /api/sessions` 获取实际地址。接口只供本机使用。

| 方法与路径 | 用途 |
|---|---|
| `GET /api/state` | 当前状态、动画、会话及桌宠运行信息。 |
| `GET /api/sessions` | 已注册扩展会话及心跳信息。 |
| `GET /api/events` | SSE 状态流，状态变化时发送 `state` 事件。 |
| `GET /api/pets` | 列出桌宠库。 |
| `POST /api/pet/show`、`/api/pet/hide`、`/api/pet/toggle` | 召唤、收回或切换桌宠。 |
| `POST /api/say` | 显示气泡；JSON 形如 `{"text":"你好","durationSec":4}`。 |
| `POST /api/animation` | 设置动画；JSON 形如 `{"animation":"sleep"}`。 |
| `POST /api/chat` | 发送聊天；JSON 为 `{"text":"你好"}`，也接受 `message` 字段。 |
| `POST /api/look_at_copilot` | 设置 `{"enabled":true}`；省略 `enabled` 时切换。 |
| `POST /api/reload` | 重新读取配置。 |
| `POST /api/open_folder` | 在资源管理器中打开桌宠库目录。 |
| `POST /api/pets/save` | 保存当前桌宠副本。 |
| `POST /api/pets/import` | 导入配置和贴图并切换。 |
| `POST /api/pets/activate` | 按 `{"id":"UUID"}` 切换桌宠。 |
| `POST /api/pets/delete` | 按 `{"id":"UUID"}` 删除；最后一只当前桌宠不能删除。 |
| `POST /api/working`、`/api/idle`、`/api/activity` | 可选的外部活动状态推送，需启用 `externalEvents`。 |

聊天接口可能返回 400（输入无效）、429（已有聊天进行中）、503（没有可用会话）或 504（超时/错误）。

## 外部事件（可选）

不启动 Copilot 会话也可让其他本机程序驱动工作动画。先在 `pet.json` 中启用监听：

```json
"externalEvents": { "enabled": true, "port": 0, "token": "设置一个本机口令" }
```

`port: 0` 表示使用扩展主服务端口。若设置 `token`，请求必须包含 `X-Pet-Token` 请求头或 `?token=` 参数。未启用时这些端点返回 403。调用示例：

```powershell
$base = "http://127.0.0.1:10405"
Invoke-RestMethod -Method Post -Uri "$base/api/working" -ContentType "application/json" -Body "{}"
Invoke-RestMethod -Method Post -Uri "$base/api/idle" -ContentType "application/json" -Body "{}"
```

若扩展因端口占用而使用随机端口，请用实际服务地址替换示例中的端口。长期任务应在开始时推送 `working`，结束时推送 `idle`。

## 状态联动

桌宠按以下来源判断工作状态：

1. 当前扩展会话的事件：收到消息或推理时进入 `thinking`，执行工具时进入 `work`；`session.idle` 会触发结束状态。
2. 扩展会话心跳注册表：读取加载本扩展的其他会话状态。
3. Copilot 会话事件日志：兜底感知未加载本扩展的其他会话；独立模式也会检查近期日志活动。
4. 外部事件：启用后接受本机程序推送的活动状态。

正常完成、中止和错误分别触发 `review`、`aborted` 和 `error` 动画；如果配置没有对应动画，会按可用动画回退。

## 开发与测试

需要 Node.js 18+。运行测试：

```powershell
npm test
```

测试基于 Node.js 内置测试运行器，不需要额外运行时依赖。更多开发与贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可与素材

本仓库代码采用 MIT License，见 [LICENSE](LICENSE)。仓库内置的 Octocat 贴图及其素材许可不属于 MIT 许可范围；来源和使用说明见 [assets/README.md](assets/README.md)。