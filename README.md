# 终端自动应答

只通过 [Herdr](https://github.com/herdrdev/herdr) 管理 Pi / Claude / Codex / Grok：读 pane 文本、用 Herdr 的 idle/working 状态，空闲后 `agent.prompt` 发送下一轮。

## 下载

从 [GitHub Releases](https://github.com/uasier/pi-auto/releases) 获取安装包：

- macOS Apple Silicon：`pi-auto_*_aarch64.dmg`
- macOS Intel：`pi-auto_*_x64.dmg`

安装包未签名，首次请右键 App → 打开。应用内点版本号可检查更新。

> 更新检查默认仓库是 `uasier/pi-auto`。fork 后请改 `src-tauri/src/update.rs` 里的 `DEFAULT_REPO`，或设环境变量 `PI_AUTO_GITHUB_REPO`。

## 前提

1. 安装并启动 [Herdr](https://herdr.dev/docs/install/) 或 Pi Agent Desktop
2. 在 **Herdr pane** 里运行 agent（普通 VS Code / Terminal.app 无法接入）
3. 出现 `~/.config/herdr/herdr.sock`

## 开发

```bash
npm install
npm test
npm run test:rust
npm run tauri dev
```

打包：

```bash
npm run tauri build
# 或
npm run tauri:build:mac
```

## 发布

三个版本号必须一致：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（以及对应 lock）。

```bash
# 只校验
npm run version:check

# 同步到指定版本（不提交）
npm run version:set -- 0.2.0

# 同步版本、提交并打 annotated tag（不推送）
npm run release:tag -- 0.2.0
git push origin HEAD && git push origin v0.2.0
```

推送 `v*` tag 后，GitHub Actions 会在 macOS arm64 / x64 构建，并上传到该 tag 的 GitHub Release。也可在 Actions 里手动 `workflow_dispatch`，填已有 tag 补传安装包。

## 注意事项

- 仓库根目录应是本目录（`pi-auto/`），不要把上层中文文件夹当作 Git 根。
- 安装包未签名。macOS 请右键选择「打开」。
- 更新检查走 GitHub Releases API，仓库必须公开，或自行处理 token。
- 发布资源名固定为 ASCII：`pi-auto_[version]_[arch].dmg`，避免中文产品名被剥掉。
- Herdr 必须先于本应用运行；上下文压缩依赖终端底部百分比显示。

## 许可证

本项目采用 [MIT License](LICENSE) 发布。
