# 终端自动应答

通过 [Herdr](https://github.com/herdrdev/herdr) 接管 Pi / Claude / Codex / Grok 的 pane：读终端、看 idle / working，空闲后发送下一轮。计划绑在当前窗口上，换会话不会把任务带走。

项目主页：<https://uasier.github.io/pi-auto/>

## 下载

从 [GitHub Releases](https://github.com/uasier/pi-auto/releases) 安装：

- macOS Apple Silicon：`pi-auto_*_aarch64.dmg`
- macOS Intel：`pi-auto_*_x64.dmg`

安装包未签名。首次请右键 App → 打开。菜单里的「检查更新…」会对照最新 tag 下载安装包。

> 更新检查默认仓库是 `uasier/pi-auto`。fork 后改 `src-tauri/src/update.rs` 里的 `DEFAULT_REPO`，或设置 `PI_AUTO_GITHUB_REPO`。

## 前提

1. 安装并启动 [Herdr](https://herdr.dev/docs/install/)
2. 在 **Herdr pane** 里运行 agent。普通 VS Code / Terminal.app 无法接入
3. 本机出现 `~/.config/herdr/herdr.sock`

未连接时，左侧有安装引导。

## 怎么用

左边选会话，中间看终端，右边排计划和循环。

- **计划**：在执行面板上方添加、编辑或导入任务。计划只属于当前选中的窗口。
- **循环**：空闲稳定后发下一条。可设循环次数、空闲秒数，以及上下文百分比。超过阈值会先发压缩，再发下一条。
- **卡住**：循环进行中，若 5 分钟内终端变化不到 1%，且 agent 不是 idle，会输入「继续」。
- **续跑**：每轮结束后要求列出下一步，由 Jev、DeepSeek 或 Laya 选一项再发。可限制最多几次。置信不够或模型选择停止时，不再续跑。
- **提交**：任务和续跑都结束后，单独再发一轮 `git commit`。不 push。

终端预览按 pane 的行列显示，不把一行折成多行。

## 密钥

应用菜单 → **密钥设置…**（⌘ ,）。Jev、DeepSeek、Laya 各自填写 Key 和 base URL。检查用的是当前输入，不必先保存。Key 留空时使用环境变量，地址留空时使用默认值。

| 决策 | 默认地址 | 环境变量 |
| --- | --- | --- |
| Jev | `https://api.typesafe.ai` | `TYPESAFE_API_KEY` |
| DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| Laya | `http://127.0.0.1:8100` | `LAYA_API_KEY`（可空）、`LAYA_BASE_URL` |

只填域名即可，请求时会补上对应路径。Laya 需要本机服务提供 `/health` 和 `/v1/systemone`。

## 没选会话时

没选会话时，中间可以在贪吃蛇和恐龙之间切换。贪吃蛇由手动、Jev 或 Laya 驱动，收到决策才走。恐龙节奏较慢，可手动，或交给 Laya 按实时距离决定跳或蹲。最高分记在本机。

## 菜单

- **密钥设置…** ⌘ ,
- **检查更新…**
- **使用说明** ⌘ /
- **关闭窗口** ⌘ W。关闭窗口会退出应用，不留在后台
- **退出** ⌘ Q

## 开发

```bash
npm install
npm test
npm run test:rust
npm run tauri dev
```

打包：

```bash
npm run tauri:build:mac
```

产物会复制到仓库根目录的 [`release/`](./release/)（`.dmg` 与 `.app`）。

## 发布

`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和对应 lock 的版本号必须一致。

```bash
npm run version:check
npm run version:set -- 0.2.4
npm run release:tag -- 0.2.4
git push origin HEAD && git push origin v0.2.4
```

推送 `v*` tag 后，GitHub Actions 会在 macOS arm64 / x64 构建，并上传到该 tag 的 Release。也可以在 Actions 里手动运行，把安装包补到已有 tag。

## 注意事项

- Git 根目录是本目录（`pi-auto/`），不要把上层中文文件夹当作仓库。
- 安装包未签名。macOS 请右键选择「打开」。
- 更新检查走 GitHub Releases API。仓库需公开，或自行处理 token。
- 发布资源名固定为 `pi-auto_[version]_[arch].dmg`，避免中文产品名被剥掉。
- Herdr 要先于本应用运行。上下文压缩依赖终端里能读到的百分比。
- Laya 的推理不要并发打。本应用同一时间只发一个决策请求。

## 许可证

[MIT License](LICENSE)
