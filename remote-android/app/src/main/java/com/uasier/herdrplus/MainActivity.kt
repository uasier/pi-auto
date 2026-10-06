package com.uasier.herdrplus

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
import android.net.http.SslError
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var pageReady = false
    private var pendingConfig: Triple<String, String, String>? = null
    private var pendingPane: String? = null
    private var loginLayer: LinearLayout? = null
    private var lastInsetBottom = -1

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        val root = findViewById<FrameLayout>(android.R.id.content).getChildAt(0)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val bottom = maxOf(bars.bottom, ime.bottom)
            view.setPadding(bars.left, bars.top, bars.right, bottom)
            if (bottom != lastInsetBottom) {
                lastInsetBottom = bottom
                if (pageReady) web.evaluateJavascript("window.__relay&&window.__relay.refit&&window.__relay.refit()", null)
            }
            insets
        }
        askNotifications()
        web = findViewById(R.id.web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.settings.textZoom = 100
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        web.setBackgroundColor(0xFF0B0D11.toInt())
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        web.isVerticalScrollBarEnabled = false
        web.addJavascriptInterface(Bridge(), "NativeRelay")
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                pageReady = true
                web.evaluateJavascript("document.body.classList.add('native')", null)
                flushPending()
            }
        }
        web.loadUrl("file:///android_asset/www/index.html")
        readIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readIntent(intent)
        if (pageReady) flushPending()
    }

    override fun onResume() {
        super.onResume()
        RelayHub.setVisible(true)
        RelayHub.listener = { text -> deliver(text) }
        RelayHub.flush()
        if (pageReady) web.evaluateJavascript("window.__relay&&window.__relay.refreshNotify&&window.__relay.refreshNotify()", null)
    }

    override fun onPause() {
        RelayHub.setVisible(false)
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (pageReady) web.evaluateJavascript("window.__relay&&window.__relay.refreshNotify&&window.__relay.refreshNotify()", null)
    }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    private fun readIntent(intent: Intent?) {
        val pane = intent?.getStringExtra(RelayService.EXTRA_PANE)
        if (!pane.isNullOrBlank()) pendingPane = pane
        val data = intent?.data ?: return
        if (data.scheme != "herdrplus") return
        pendingConfig = Triple(
            data.getQueryParameter("url").orEmpty(),
            data.getQueryParameter("token").orEmpty(),
            data.getQueryParameter("pin").orEmpty(),
        )
    }

    private fun flushPending() {
        pendingConfig?.let { (url, token, pin) ->
            pendingConfig = null
            applyConfig(url, token, pin)
        }
        pendingPane?.let { pane ->
            pendingPane = null
            web.evaluateJavascript("window.__relay&&window.__relay.openPane(${js(pane)})", null)
        }
    }

    private fun applyConfig(url: String, token: String, pin: String) {
        val script = "window.__relay&&window.__relay.applyConfig(${js(url)},${js(token)},${js(pin)})"
        web.post { web.evaluateJavascript(script, null) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showLogin(url: String) {
        closeLogin()
        val root = findViewById<FrameLayout>(android.R.id.content).getChildAt(0) as FrameLayout
        val layer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0B0D11.toInt())
        }
        val bar = LinearLayout(this).apply { gravity = Gravity.END }
        val browser = loginButton("用浏览器打开") { openExternal(url) }
        val close = loginButton("关闭") { closeLogin() }
        bar.addView(browser)
        bar.addView(close)
        val login = WebView(this)
        login.settings.javaScriptEnabled = true
        login.settings.domStorageEnabled = true
        login.settings.userAgentString = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(login, true)
        login.tag = "login"
        login.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                val host = Uri.parse(error?.url ?: "").host
                if (host == "154.36.168.192") handler?.proceed() else handler?.cancel()
            }

            override fun onPageFinished(view: WebView?, finished: String?) {
                if (finished?.contains("/auth/github/callback") == true && finished.contains("error=").not()) {
                    login.postDelayed({ closeLogin() }, 700)
                }
            }
        }
        layer.addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        layer.addView(login, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        loginLayer = layer
        root.addView(layer, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        login.loadUrl(url)
    }

    private fun loginButton(label: String, action: () -> Unit): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            setTextColor(0xFFE7EBF2.toInt())
            setBackgroundColor(0xFF1C2129.toInt())
            setOnClickListener { action() }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(44)).apply {
                marginEnd = dp(8)
            }
        }
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun openExternal(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        try {
            startActivity(Intent.createChooser(intent, "打开 GitHub 登录"))
        } catch (_: Exception) {
            Toast.makeText(this, "没有可用的浏览器", Toast.LENGTH_LONG).show()
        }
    }

    private fun closeLogin() {
        val layer = loginLayer ?: return
        (layer.parent as? FrameLayout)?.removeView(layer)
        layer.findViewWithTag<WebView>("login")?.destroy()
        loginLayer = null
    }

    override fun onBackPressed() {
        if (loginLayer != null) {
            closeLogin()
            return
        }
        super.onBackPressed()
    }

    private fun deliver(text: String) {
        val payload = Base64.encodeToString(text.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        web.post { web.evaluateJavascript("window.__relay&&window.__relay.onB64('$payload')", null) }
    }

    private fun startRelay(url: String, token: String, pin: String, session: String) {
        val intent = Intent(this, RelayService::class.java)
            .putExtra(RelayService.EXTRA_URL, url)
            .putExtra(RelayService.EXTRA_TOKEN, token)
            .putExtra(RelayService.EXTRA_PIN, pin)
            .putExtra(RelayService.EXTRA_SESSION, session)
        ContextCompat.startForegroundService(this, intent)
    }

    private inner class Bridge {
        @JavascriptInterface
        fun connect(url: String, token: String, pin: String, session: String) {
            runOnUiThread { startRelay(url, token, pin, session) }
        }

        @JavascriptInterface
        fun request(url: String, path: String, body: String, pin: String): String {
            return PinnedHttp.post(url, path, body, pin)
        }

        @JavascriptInterface
        fun open(url: String): String {
            if (!url.startsWith("https://")) return "登录地址无效"
            runOnUiThread { showLogin(url) }
            return ""
        }

        @JavascriptInterface
        fun send(text: String) {
            SocketBus.send(text)
        }

        @JavascriptInterface
        fun disconnect() {
            startService(Intent(this@MainActivity, RelayService::class.java).setAction(RelayService.ACTION_DISCONNECT))
        }

        @JavascriptInterface
        fun notificationState(): String {
            return if (RelayService.notificationGranted(this@MainActivity)) "granted" else "denied"
        }

        @JavascriptInterface
        fun requestNotifications() {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= 33 && !RelayService.notificationGranted(this@MainActivity)) {
                    askNotifications()
                } else {
                    startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
                }
            }
        }

        @JavascriptInterface
        fun browse(url: String): String {
            if (!url.startsWith("https://")) return "链接无效"
            runOnUiThread { openExternal(url) }
            return ""
        }

        @JavascriptInterface
        fun appVersion(): String = versionName()

        @JavascriptInterface
        fun checkUpdate(): String = Updater.toJson(Updater.check(versionName()))

        @JavascriptInterface
        fun installUpdate(): String {
            return try {
                val info = Updater.check(versionName())
                if (!info.available) return Updater.toJson(info, ok = false, message = "当前已是最新版本")
                if (info.assetUrl.isBlank()) return Updater.toJson(info, ok = false, message = "GitHub Release 里还没有 Android 安装包")
                val file = Updater.download(info, java.io.File(cacheDir, "updates"))
                val result = arrayOf("")
                val done = java.util.concurrent.CountDownLatch(1)
                runOnUiThread {
                    result[0] = Updater.install(this@MainActivity, file)
                    done.countDown()
                }
                done.await(8, java.util.concurrent.TimeUnit.SECONDS)
                result[0].ifBlank { "{\"ok\":false,\"message\":\"无法打开安装器\"}" }
            } catch (err: Exception) {
                "{\"ok\":false,\"message\":${org.json.JSONObject.quote(err.message ?: "更新失败")}}"
            }
        }

        @JavascriptInterface
        fun keepAlive() {
            runOnUiThread {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                runCatching { startActivity(intent) }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun versionName(): String {
        return packageManager.getPackageInfo(packageName, 0).versionName ?: "0.0.0"
    }

    companion object {
        private fun js(raw: String): String {
            val escaped = raw.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "")
            return "'$escaped'"
        }
    }
}

object SocketBus {
    @Volatile var sender: ((String) -> Unit)? = null
    fun send(text: String) {
        sender?.invoke(text)
    }
}
