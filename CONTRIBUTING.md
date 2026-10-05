# 贡献指南

感谢你对 Copilot 桌宠的关注！

## 开发环境

- Windows 10/11（桌面窗基于 WPF + PowerShell 5.1）
- Node.js 18+（扩展运行于 Copilot App 内置运行时）
- 将仓库放到 Copilot 扩展目录，或软链接过去，重载扩展即可调试

## 项目结构

| 文件 | 职责 |
|---|---|
| `extension.mjs` | 扩展入口：agent tools、画布面板、本地 HTTP 服务、跨会话心跳 |
| `pet-window.ps1` | 桌面悬浮窗与动画状态机 |
| `pet.html` | 画布预览面板 |
| `pet.example.json` | 示例配置 |

## 提交流程

1. Fork 并从 `master` 创建分支：`feat/xxx`、`fix/xxx`、`docs/xxx`
2. 保持改动小而聚焦，一个 PR 只做一件事
3. 提交信息建议使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，如 `fix: 其他会话工作状态不显示`
4. 发起 PR，说明动机、改动内容与测试方式；UI 变化请附截图或 GIF

## 代码规范

- JS 使用 ES Modules，4 空格缩进，双引号，保留分号
- 不引入额外运行时依赖，保持零依赖
- 修改已有代码时保留无关的注释
- 新增配置项须同步更新 `README.md` 与 `pet.example.json`
- 不要提交 `pet.json`、个人贴图等本地文件（已在 `.gitignore`）
- 文本文件统一使用 UTF-8 编码
- 本项目无法在移动端（安卓、鸿蒙、iOS）进行测试，请勿提交移动端相关代码
    - 本项目拒绝移动端AI代理执行器
- 提交代码请确保在`Windows 10/11` `Mac OS` `Linux` 三个平台其中之一可以正常运行
    - 顺带注明使用的什么操作系统和AI模型

## 提交前自检

- [ ] 扩展能正常加载，无报错
- [ ] 至少在两个会话同时运行下验证工作状态联动
- [ ] 桌宠能正常召唤、收回、走动、睡眠
- [ ] 文档已同步更新

## 反馈问题

请在 Issue 中提供：系统版本、Copilot App 版本、复现步骤、期望与实际表现，以及相关日志。
