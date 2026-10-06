# herdr+ 主服务

GitHub 登录和中继在同一个进程里。同一 GitHub 账号登录电脑、网页、APK 后自动进同一个房间。

在 GitHub 新建 OAuth App：回调填 `https://154.36.168.192:8443/auth/github/callback`，并勾选 Enable Device Flow。然后把下面两行写到服务器 `/etc/herdr-relay/github.env`，`chmod 640`，属组 `herdr-relay`，再 `systemctl restart herdr-relay`。

```
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

# herdr-relay

电脑上的 herdr+ 主动连出，手机只连这台中继。中继不连接 Herdr，也不记录终端内容。

当前部署：

- 地址：`wss://154.36.168.192:8443/v1/ws`
- 页面：`https://154.36.168.192:8443/`
- 证书指纹写在桌面端「通道」里，可替换
- 主机钥匙在 `/etc/herdr-relay/token`。手机配对码在 `/var/lib/herdr-relay/accounts.json`，只由主机签发

常用命令：

```bash
systemctl status herdr-relay
systemctl restart herdr-relay
curl -k https://154.36.168.192:8443/health
```

作废某一台手机：在电脑的「通道」里点作废。换主机钥匙才需要改 `/etc/herdr-relay/token` 并重启。80/443 已被占用，不要改过去。
