package com.uasier.herdrplus

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Base64
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class RelayService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val panes = linkedMapOf<String, PaneSnap>()
    private var socket: WebSocket? = null
    private var wake: PowerManager.WakeLock? = null
    private var generation = 0
    private var reconnectQueued = false
    private var userStopped = false
    private var allowInput = true
    private var hostOnline = false
    private var herdrConnected = true
    private var reconnecting = false
    private var attempts = 0
    private var connectedAt = 0L
    private var url = ""
    private var token = ""
    private var pin = ""
    private var session = ""
    private val seen = linkedMapOf<String, String>()
    private var hostDownAlerted = false
    private var herdrAlerted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.ensure(this)
        RelayHub.onVisible = { visible -> if (visible) acknowledge() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifier.ensure(this)
        startInForeground(currentStatus())
        when (intent?.action) {
            ACTION_DISCONNECT -> {
                shutdown()
                return START_NOT_STICKY
            }
            ACTION_NUDGE -> {
                nudge(intent.getStringExtra(EXTRA_PANE).orEmpty())
                return START_STICKY
            }
            else -> connectFrom(intent)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        RelayHub.onVisible = null
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "bye")
        releaseWake()
        super.onDestroy()
    }

    private fun connectFrom(intent: Intent?) {
        val incoming = intent?.getStringExtra(EXTRA_URL).orEmpty()
        if (incoming.isNotBlank()) {
            url = incoming
            token = intent?.getStringExtra(EXTRA_TOKEN).orEmpty()
            pin = intent?.getStringExtra(EXTRA_PIN).orEmpty()
            session = intent?.getStringExtra(EXTRA_SESSION).orEmpty()
            savePrefs()
        } else if (url.isBlank()) {
            val prefs = prefs()
            if (!prefs.getBoolean(KEY_ARMED, false)) {
                refresh("通道未连接", "打开应用后连接", false)
                return
            }
            url = prefs.getString(KEY_URL, "").orEmpty()
            token = prefs.getString(KEY_TOKEN, "").orEmpty()
            pin = prefs.getString(KEY_PIN, "").orEmpty()
            session = prefs.getString(KEY_SESSION, "").orEmpty()
        }
        connect()
    }

    private fun connect() {
        val cleanPin = pin.filter { !it.isWhitespace() && it != ':' }
        if (!url.startsWith("wss://") || cleanPin.length != 64 || session.isBlank()) {
            RelayHub.emit("""{"type":"error","message":"请先用 GitHub 登录"}""")
            if (!RelayHub.resumed) Notifier.loginExpired(this, "请先用 GitHub 登录")
            refresh("无法连接", "请先用 GitHub 登录", false)
            return
        }
        userStopped = false
        reconnectQueued = false
        generation += 1
        val gen = generation
        socket?.close(1000, "reconnect")
        val client = client(cleanPin)
        val join = if (url.contains("?")) "&" else "?"
        val query = "session=${Uri.encode(session)}"
        val request = Request.Builder()
            .url("$url$join$query")
            .build()
        refresh(if (attempts == 0) "正在连接" else "正在重连", "第 ${attempts + 1} 次", true)
        val opened = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (gen != generation) return
                val recovered = attempts > 0
                attempts = 0
                reconnecting = false
                connectedAt = System.currentTimeMillis()
                acquireWake()
                refresh(if (recovered) "通道已恢复" else "herdr+ 已连接", "正在同步会话", false)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != generation) return
                RelayHub.emit(text)
                handle(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (gen != generation || userStopped) return
                val code = response?.code ?: 0
                val detail = response?.body?.string()?.trim().orEmpty().ifBlank { t.message ?: "连接失败" }
                RelayHub.emit("""{"type":"error","message":${jsonString(detail)}}""")
                if (code == 401 || code == 403) {
                    generation += 1
                    refresh("登录已失效", detail, false)
                    if (!RelayHub.resumed) Notifier.loginExpired(this@RelayService, detail)
                    return
                }
                queueReconnect(gen, detail)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                queueReconnect(gen, reason.ifBlank { "连接已关闭" })
            }
        })
        socket = opened
        SocketBus.sender = { text -> if (gen == generation) opened.send(text) }
    }

    private fun queueReconnect(gen: Int, reason: String) {
        if (gen != generation || userStopped || reconnectQueued) return
        reconnectQueued = true
        scheduleReconnect(reason)
    }

    private fun scheduleReconnect(reason: String) {
        reconnecting = true
        attempts += 1
        hostOnline = false
        val wait = (1000L shl (attempts - 1).coerceAtMost(4)).coerceAtMost(20_000L)
        refresh("正在重连", reason, true)
        handler.postDelayed({
            if (!userStopped) connect()
        }, wait)
    }

    private fun handle(text: String) {
        val msg = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        when (msg.optString("type")) {
            "relay.welcome" -> {
                hostOnline = msg.optBoolean("hostOnline")
                refresh(if (hostOnline) "电脑在线" else "等待电脑", "通道已连接", false)
            }
            "relay.peer" -> if (msg.optString("role") == "host") {
                hostOnline = msg.optString("event") == "join"
                if (hostOnline) {
                    hostDownAlerted = false
                } else {
                    panes.keys.forEach { Notifier.cancelPane(this, it) }
                    panes.clear()
                    seen.clear()
                    if (!RelayHub.resumed && !hostDownAlerted) {
                        hostDownAlerted = true
                        Notifier.hostDown(this)
                    }
                }
                refresh(if (hostOnline) "电脑在线" else "电脑已断开", summaryText(), false)
            }
            "host.state" -> {
                allowInput = msg.optBoolean("allowInput", true)
                refresh(currentTitle(), summaryText(), false)
            }
            "herdr" -> {
                herdrConnected = msg.optBoolean("connected", true)
                if (!herdrConnected) {
                    if (!RelayHub.resumed && !herdrAlerted) {
                        herdrAlerted = true
                        Notifier.attention(this, "Herdr 未连接", msg.optString("error").ifBlank { "电脑上的 Herdr 没有在运行" })
                    }
                } else {
                    herdrAlerted = false
                }
                refresh(currentTitle(), summaryText(), false)
            }
            "sessions" -> diffSessions(msg.optJSONArray("items") ?: JSONArray())
        }
    }

    private fun diffSessions(items: JSONArray) {
        val next = linkedMapOf<String, PaneSnap>()
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            val id = item.optString("paneId")
            if (id.isBlank()) continue
            val snap = PaneSnap(
                title = item.optString("title").ifBlank { id },
                agent = item.optString("agentLabel").ifBlank { item.optString("agent").ifBlank { "终端" } },
                state = item.optString("agentState").ifBlank { "unknown" },
            )
            val prev = panes[id]
            if (prev != null && prev.state != snap.state) onState(id, prev.state, snap)
            next[id] = snap
        }
        panes.keys.filter { it !in next }.forEach {
            seen.remove(it)
            Notifier.cancelPane(this, it)
        }
        panes.clear()
        panes.putAll(next)
        refresh(currentTitle(), summaryText(), false)
    }

    private fun onState(id: String, prev: String, snap: PaneSnap) {
        seen[id] = snap.state
        val finished = snap.state == "idle" || snap.state == "done"
        if (finished && (prev == "working" || prev == "blocked")) {
            Notifier.session(this, "${snap.title} 已完成", "${snap.agent} 可以发下一句", id, true, allowInput)
            return
        }
        if (RelayHub.resumed) {
            if (!finished) Notifier.cancelPane(this, id)
            return
        }
        when (snap.state) {
            "blocked" -> Notifier.session(this, "${snap.title} 等待确认", "${snap.agent} 停在确认上，打开后处理", id, true, false)
            "working" -> Notifier.cancelPane(this, id)
        }
    }

    private fun acknowledge() {
        panes.forEach { (id, snap) -> seen[id] = snap.state }
        hostDownAlerted = !hostOnline
        herdrAlerted = !herdrConnected
        Notifier.clearTransient(this)
    }

    private fun nudge(paneId: String) {
        if (paneId.isBlank() || !allowInput) return
        val bytes = Base64.encodeToString("继续\r".toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        socket?.send(JSONObject().put("type", "term.input").put("paneId", paneId).put("bytes", bytes).toString())
        Notifier.cancelPane(this, paneId)
    }

    private fun shutdown() {
        userStopped = true
        generation += 1
        handler.removeCallbacksAndMessages(null)
        prefs().edit().putBoolean(KEY_ARMED, false).apply()
        socket?.close(1000, "bye")
        socket = null
        SocketBus.sender = null
        releaseWake()
        Notifier.clearAttention(this)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun currentTitle(): String {
        return when {
            reconnecting -> "正在重连"
            !hostOnline -> "等待电脑"
            !herdrConnected -> "Herdr 未连接"
            panes.values.any { it.state == "blocked" } -> "有会话要确认"
            !allowInput -> "只读"
            else -> "herdr+ 已连接"
        }
    }

    private fun summaryText(): String {
        if (!hostOnline) return "电脑不在线"
        if (!herdrConnected) return "电脑上的 Herdr 没有连上"
        val working = panes.values.count { it.state == "working" }
        val blocked = panes.values.count { it.state == "blocked" }
        val idle = panes.values.count { it.state == "idle" || it.state == "done" }
        val parts = mutableListOf<String>()
        if (working > 0) parts += "$working 执行中"
        if (blocked > 0) parts += "$blocked 等待确认"
        if (idle > 0) parts += "$idle 空闲"
        if (!allowInput) parts += "只读"
        return parts.joinToString(" · ").ifBlank { "没有会话" }
    }

    private fun currentStatus(): ChannelStatus {
        return ChannelStatus(
            title = currentTitle(),
            text = summaryText(),
            lines = panes.values.map { "${it.agent} · ${it.title} · ${stateLabel(it.state)}" },
            connected = hostOnline && !reconnecting,
            reconnecting = reconnecting,
            since = if (connectedAt == 0L) System.currentTimeMillis() else connectedAt,
        )
    }

    private fun refresh(title: String, text: String, spinning: Boolean) {
        reconnecting = spinning
        Notifier.updateForeground(
            this,
            ChannelStatus(title, text, currentStatus().lines, hostOnline && !spinning, spinning, currentStatus().since),
        )
    }

    private fun startInForeground(status: ChannelStatus) {
        val notice = Notifier.foreground(this, status)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(Notifier.STATUS_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(Notifier.STATUS_ID, notice)
        }
    }

    private fun savePrefs() {
        prefs().edit()
            .putBoolean(KEY_ARMED, true)
            .putString(KEY_URL, url)
            .putString(KEY_TOKEN, token)
            .putString(KEY_PIN, pin)
            .putString(KEY_SESSION, session)
            .apply()
    }

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    private fun acquireWake() {
        if (wake == null) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "herdrplus:channel")
        }
        if (wake?.isHeld != true) wake?.acquire(6 * 60 * 60 * 1000L)
    }

    private fun releaseWake() {
        wake?.let { if (it.isHeld) it.release() }
    }

    private fun client(pin: String): OkHttpClient {
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isEmpty()) throw CertificateException("没有证书")
                val digest = MessageDigest.getInstance("SHA-256").digest(chain[0].encoded)
                val hex = digest.joinToString("") { "%02x".format(it) }
                if (!hex.equals(pin, ignoreCase = true)) throw CertificateException("证书指纹不匹配")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val ssl = SSLContext.getInstance("TLS")
        ssl.init(null, arrayOf(trust), SecureRandom())
        return OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, trust)
            .hostnameVerifier { _, _ -> true }
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
    }

    companion object {
        const val ACTION_DISCONNECT = "disconnect"
        const val ACTION_NUDGE = "nudge"
        const val EXTRA_URL = "url"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_PIN = "pin"
        const val EXTRA_SESSION = "session"
        const val EXTRA_PANE = "pane"
        private const val PREFS = "herdr-plus-channel"
        private const val KEY_ARMED = "armed"
        private const val KEY_URL = "url"
        private const val KEY_TOKEN = "token"
        private const val KEY_PIN = "pin"
        private const val KEY_SESSION = "session"

        fun notificationGranted(context: Context): Boolean {
            return if (Build.VERSION.SDK_INT < 33) true
            else context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED
        }

        private fun jsonString(raw: String): String {
            return "\"" + raw.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        }

        private fun stateLabel(state: String): String {
            return when (state) {
                "idle" -> "空闲"
                "done" -> "完成"
                "working" -> "执行中"
                "blocked" -> "等待确认"
                else -> "未知"
            }
        }
    }
}

private data class PaneSnap(val title: String, val agent: String, val state: String)
