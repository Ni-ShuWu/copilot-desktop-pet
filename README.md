# 桌宠 Desktop Pet

一只住在 Windows 桌面上的 2D 桌宠，基于 GitHub Copilot App 扩展实现。
透明置顶悬浮窗、会自己走动、可拖拽、戳一戳会说话，还会跟着 Copilot 会话联动——
**你在写代码，它在旁边敲电脑；你干完活，它复盘并冒泡汇报。**

## 功能

- 🖥️ 真·桌面悬浮窗（WPF 透明置顶）：走动 / 睡觉 / 跳跃 / 挥手 / 工作 / 复盘
- 💬 戳一戳随机冒泡说话；agent 可让桌宠说任意内容
- 🔗 会话联动：agent 跑工具时桌宠坐下敲电脑（头顶 🛠），任务完成自动汇报
- 🌐 跨会话感知：任意一个 Copilot 会话在工作，桌宠都知道（心跳注册表 + 事件日志双重检测）
- 🚀 打开 Copilot 自动召唤（`autoStart`）
- 🎛️ 画布面板：预览动画、召唤 / 收回桌宠
- 🎨 配置驱动换装：一张 spritesheet + 一个 `pet.json` 就是一只新桌宠

## 安装

1. 把本仓库全部文件复制到项目的 `.github/extensions/desktop-pet/` 目录下
2. 复制 `pet.example.json` 为 `pet.json`，按下面「配置」一节修改
3. 放入你自己的 `spritesheet.png` 贴图
4. 在 Copilot App 中重载扩展，打开「桌宠」画布，点「召唤桌宠」

## 使用

直接对 Copilot 说：

- 「召唤桌宠」/「收回桌宠」
- 「让桌宠说：……」
- 「让桌宠播 xxx 动画」/「恢复自动行为」

手动启动：**双击 `start-pet.bat`**（或 `powershell -File start-pet.ps1`）。
脚本会自动判断：已经在跑就提示不重复召唤；有 Copilot 会话加载了扩展就让该实例召唤
（联动会话状态）；都没有则独立模式直接拉起 `pet-window.ps1`（不联动会话状态）。

桌面上：

- 左键拖拽移动；单击（不拖动）戳一戳说话
- 右键菜单：开关自动走动、让它睡觉、退出

## 配置（pet.json）

`pet.json` 是桌宠的全部定义，**改完无需重启**，桌面窗和面板几秒内自动热更新。

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
    "review":  { "row": 8, "frames": 6 }
  },
  "behavior": {
    "autoWander": true,
    "walkSpeedPxPerSec": 60,
    "wanderIntervalSec": [4, 9],
    "sleepAfterIdleSec": 40
  },
  "speech": {
    "phrases": ["……什么事？", "嗯，我在。", "别戳了。"],
    "fontSize": 13
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
| `scale` | number | 4 | 显示放大倍数（像素风小贴图建议 3~4；大贴图设 1） |
| `fps` | number | 8 | 全局帧率 |
| `defaultAnimation` | string | `"idle"` | 待机时播放的动画名 |

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
| `work` | **任意会话的 agent 正在跑工具时**（没有则保持 idle） |
| 其他任意名 | 可通过 `desktop_pet_set_animation` 工具或画布动作手动播放 |

### behavior（行为）

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoWander` | true | 是否自主走动 |
| `walkSpeedPxPerSec` | 40 | 走动速度（像素/秒） |
| `wanderIntervalSec` | `[3, 8]` | 行为切换间隔 `[最小, 最大]` 秒 |
| `sleepAfterIdleSec` | 45 | 无交互多少秒后睡觉（0 = 不睡） |

### speech（台词）

| 字段 | 说明 |
|---|---|
| `phrases` | 戳一戳时的随机台词数组 |
| `fontSize` | 气泡字号（默认 13） |

## 自制贴图规范

- 等宽帧网格 PNG：行高 = `frameHeight`，每帧宽 = `frameWidth`，一行一个动画
- 透明背景效果最佳；桌面窗使用最近邻缩放，像素风不会被模糊
- 左右不对称的角色：左行帧单独画一行，用 `leftRow` 指向它
- 参考：`pet.example.json` 是 32×32 三行（idle/walk/sleep）的最小可运行配置

## 技术架构

```
extension.mjs    扩展入口：agent tools + 画布面板 + 本地 HTTP 服务
                 + 跨会话心跳注册表（%TEMP%\copilot-desktop-pet）+ 桌面窗进程管理
pet-window.ps1   桌面悬浮窗本体（WPF 透明置顶窗，动画状态机，配置热重载）
pet.html         画布面板：预览动画 + 召唤/收回控制栏
pet.example.json 示例配置
```

跨会话原理（两层检测，任一命中即算「有会话在工作」）：

1. **心跳注册表**：加载了本扩展的会话，每 3 秒向 `%TEMP%\copilot-desktop-pet\inst-<pid>.json`
   写一条心跳（activity、桌宠 pid）；12 秒未更新或进程已退出即视为离线。
   `GET /api/sessions` 可查看各会话实时状态。
2. **事件日志兜底**：没加载扩展的会话（比如工作树里、其他仓库里的会话），检查
   `~/.copilot/session-state/<会话>/events.jsonl` 最近 6 秒内是否有写入——有就是在干活，
   所以其他会话跑任务时你的桌宠照样敲电脑。

## 贡献

欢迎提交 Issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
