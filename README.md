# IPWindow

一个跨平台桌面悬浮窗小工具，在屏幕上显示当前公网 **IP 地址** 和 **IP 归属地**。
支持 **Windows (x64)** 和 **macOS（Intel x64 + Apple Silicon arm64）**。

A cross-platform desktop widget that shows your current public **IP address** and
its **geolocation**. Runs on **Windows (x64)** and **macOS (Intel x64 + Apple Silicon arm64)**.

---

## 功能 / Features

应用会**自动检测操作系统**，选择最贴合该平台的显示方式：

- **Windows 11（任务栏模式）**：把 IP 与位置嵌入到**任务栏最左侧**，两行显示——第一行 IP、第二行地址，右侧带一个**刷新按钮**。鼠标悬停时弹出浮层，显示含**运营商（ISP）**在内的全部详情。
- **macOS（菜单栏模式）**：把地址（可在托盘菜单切换为 IP / 运营商）显示在**菜单栏**，鼠标移上去弹出浮层显示全部详情。
- **Windows 10 及以下 / Linux（浮窗模式）**：保留原来的桌面悬浮卡片——透明、无边框、始终置顶，显示 IP / 归属地 / 运营商 / 更新时间；**可拖动**且位置自动记录，下次启动恢复；**双击**立即刷新，悬停右上角出现 `×` 退出。

通用能力：

- **自动刷新**：每 5 分钟查询一次 IP（启动时立即查一次）。
- **跟随系统代理**：通过 Electron 的网络栈发起查询，显示的是经过系统代理后的出口 IP。
- **系统托盘 / 菜单栏图标**右键菜单：`显示面板 / 立即刷新 / 退出` 等（macOS 还可切换菜单栏显示字段）。
- **自动多语言**：检测系统语言，中文环境显示中文，其他环境显示英文（界面文字与地名均跟随）。

数据源 / Data source：[ip-api.com](http://ip-api.com)（免费、无需 API Key）。

---

## 运行 / Development

```bash
npm install
npm start
```

## 生成图标 / Regenerate icon

图标源文件为 `build/icon.svg`，用 Electron 渲染为 PNG（无原生依赖）：

```bash
npm run icons   # 输出 build/icon.png 与 assets/icon.png
```

electron-builder 会在打包时自动把 `build/icon.png` 转成 Windows 的 `.ico` 和 macOS 的 `.icns`。

---

## 打包 / Build

```bash
npm run dist:win    # Windows 安装包 (NSIS .exe, x64)        —— 在 Windows 上执行
npm run dist:mac    # macOS 安装包 (.dmg, x64 + arm64 各一个) —— 在 macOS 上执行
npm run dist        # 同时构建两个平台（需对应的宿主系统）
```

产物输出到 `dist/` 目录：

- `IPWindow-<version>-win-x64.exe`
- `IPWindow-<version>-mac-x64.dmg`（Intel）
- `IPWindow-<version>-mac-arm64.dmg`（Apple Silicon）

> 说明：
> - macOS 的 `.dmg` 打包必须在 macOS 系统上执行（依赖 `hdiutil` 等工具），无法在 Windows 上产出。
>   没有 Mac？见下方 **GitHub Actions 云端构建**。
> - 云端/未签名的 `.dmg` 在 Mac 上首次打开会被 Gatekeeper 拦截，需右键「打开」，
>   或在「系统设置 → 隐私与安全性」中点「仍要打开」。正规签名+公证需要 Apple Developer 账号。

---

## GitHub Actions 云端构建 / Cloud build

仓库内含 `.github/workflows/build.yml`，可在 GitHub 云端的 macOS / Windows 机器上构建，
**无需本地拥有 Mac**：

1. 把项目推送到 GitHub 仓库。
2. 进入仓库 **Actions** 标签页，选择 **Build installers** 工作流，点 **Run workflow** 手动触发
   （push 一个 `v*` 形式的 tag 也会自动触发）。
3. 构建完成后，在该次运行页面底部的 **Artifacts** 下载 `.dmg` / `.exe`。

公开仓库免费且无限分钟数；私有仓库每月有免费额度（macOS 机器按 10× 计费，约够每月数次构建）。

---

## 配置文件 / Config

窗口位置记录在用户数据目录的 `config.json`：

- Windows: `%APPDATA%\ip-window\config.json`
- macOS: `~/Library/Application Support/ip-window/config.json`
