# DeepSeek Harness Desktop (WSL 适配版)

**Windows 桌面客户端，连接 WSL 中已有的 DeepSeek Harness Web UI。**

基于 [ReachGa0/dsh-desktop](https://github.com/ReachGa0/dsh-desktop) 修改，移除了本地 DSH 服务管理逻辑，专为 **DSH 运行在 WSL 中、Windows 端仅需客户端** 的场景优化。

## 与原版区别

| 功能 | 原版 | 本版 |
|------|------|------|
| DSH 运行位置 | Windows 本地 | **WSL (Linux)** |
| 启动方式 | 自己启动 `dsh web` | **连接已有的** `dsh web` |
| 环境检测 | 检测 Node.js / dsh.cmd | 仅检测 localhost:3080 是否可达 |
| 首次引导 | 安装向导（Node.js / dsh） | 无（DSH 已在 WSL 中运行） |
| 重启服务 | 可重启本地 dsh | ✅ 更新 DSH 时自动重启（systemd） |
| **主动更新 DSH** | ❌ 仅检查自身 | ✅ 一键更新 WSL 内 DSH + 自动重连 |
| 选区截图 | ✅ | ✅ |
| 系统托盘 | ✅ | ✅ |
| 会话管理 | ✅ | ✅（读取 WSL 中的 `~/.dsh/sessions`） |

## 前提

- Windows 10/11（已安装 WSL2）
- WSL 中已安装并运行 DSH：`dsh --profile web`
- WSL2 默认转发 localhost 端口（如果改了，用 `--port` 指定）
- （可选，主动更新功能）WSL 启用了 systemd 且存在 `dsh.service`：未启用 systemd 时更新后需手动重启服务

## 快速开始

```bash
# 克隆
git clone https://github.com/luminus-xt/dsh-desktop.git
cd dsh-desktop

# 安装依赖
npm install

# 确保 WSL 中的 DSH 已启动，然后启动客户端
npm start

# 指定端口（如果 WSL 中的 DSH 不在 3080 端口）
npm start -- --port 3081
```

## 打包为安装程序

```bash
npm run dist
```

产物在 `release/` 目录下。

## 功能

- ⬆️ **主动更新 DSH**：启动时自动检查 npm 新版，弹窗确认后一键完成「更新包 → 重启服务 → 自动重连」；也可从托盘或 `文件 → 检查 DSH 更新…` 手动触发。版本比较支持 `-rc.N` 预发布号；npm 查询与安装同走 WSL 内源配置（兼容镜像）
- 📸 **选区截图提问**：右下角截图按钮 → 框选区域 → 自动粘贴到聊天框
- 🗂️ **会话管理**：`Alt → 文件 → 会话管理…`
- 🪟 **独立窗口**：原生桌面窗口加载 Harness Web UI
- 🍱 **系统托盘**：关窗口最小化到托盘，右键菜单退出
- 🔄 **F5 刷新**：加载新插件后刷新页面
- 🔒 **单实例**：防止双开

### 主动更新 DSH 的工作原理

1. 启动 3 秒后静默读取 WSL 内 `dsh --version` 与 `npm view @deepseek-ai/dsh version`（走 WSL 的 npm 源配置）
2. 发现新版本（含 rc 预发布升级）→ 弹窗展示版本差异，点击「立即更新」才执行
3. 更新期间主窗口切换为进度页 + 任务栏进度条，依次执行：
   `npm install -g @deepseek-ai/dsh@latest` → 校验版本 → `systemctl restart dsh`
4. 轮询端口直到服务恢复，自动重载页面并提示结果
5. 任一步失败都会给出原因和等价的手动命令，旧服务在重启前不受影响

## 许可

MIT