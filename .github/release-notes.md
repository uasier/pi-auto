修复 Android 选中 Mac 后一直等待对话列表的问题，并完善通信恢复逻辑。

- 选中 Mac 后主动同步会话和通道状态；Mac 定期刷新完整快照。
- 修复中转对 JSON 字段顺序的依赖、多设备切换状态以及断线订阅清理。
- 重连后恢复原 Mac 和终端，忽略旧连接消息；队列拥堵时重新同步画面。
- 区分“正在加载”与“暂无会话”，同步 Android 前台和后台的在线状态。

请同时升级 Mac 和 Android。中转源码中的房间状态与消息分发改进需要部署新版中转后生效，部署说明见仓库 `relay/COMMUNICATION.md`。

安装包：Apple Silicon 使用 `pi-auto_*_aarch64.dmg`；Intel 使用 `pi-auto_*_x64.dmg`；Android 使用 `herdr-plus-remote.apk`。

macOS 应用未签名。如果安装后提示已损坏，可执行：

```sh
xattr -dr com.apple.quarantine "/Applications/herdr+.app"
```
