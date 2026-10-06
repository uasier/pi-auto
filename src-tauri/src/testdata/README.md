# 通道测试夹具

`channel-cert.der` 与 `channel-key.der` 是配套的本地 TLS 测试证书和 PKCS#8 私钥。只用于 `channel.rs` 中绑定到 `127.0.0.1` 随机端口的回归测试，不用于真实服务。测试按证书指纹连接，不依赖系统信任库、公网或外部命令。

一次性生成方式如下；执行位置为项目根目录。运行测试无需重新生成。

```sh
mkdir -p .Codex
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout .Codex/channel-test-key.pem -out .Codex/channel-test-cert.pem -days 3650 -subj '/CN=localhost'
openssl x509 -in .Codex/channel-test-cert.pem -outform DER -out src-tauri/src/testdata/channel-cert.der
openssl pkcs8 -topk8 -nocrypt -in .Codex/channel-test-key.pem -outform DER -out src-tauri/src/testdata/channel-key.der
```

从项目根目录执行 `npm run test:rust`，覆盖慢 TLS 握手、慢 WebSocket 握手、握手失败后的重连，以及空闲读取超时后的正常收发。
