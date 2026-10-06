package com.uasier.herdrplus

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

object Updater {
    const val REPO = "uasier/pi-auto"

    data class Info(
        val currentVersion: String,
        val latestVersion: String,
        val available: Boolean,
        val name: String,
        val notes: String,
        val htmlUrl: String,
        val assetName: String,
        val assetUrl: String,
    )

    fun check(current: String): Info {
        val fallback = Info(current, current, false, "", "", "https://github.com/$REPO/releases", "", "")
        val body = get("https://api.github.com/repos/$REPO/releases/latest") ?: return fallback
        if (body.optString("message").isNotBlank() && body.optString("tag_name").isBlank()) {
            return fallback.copy(notes = body.optString("message"))
        }
        if (body.optBoolean("draft") || body.optBoolean("prerelease")) return fallback
        val latest = body.optString("tag_name").trim().removePrefix("v").removePrefix("V")
        val asset = pickApk(body.optJSONArray("assets") ?: JSONArray())
        val html = body.optString("html_url").ifBlank { "https://github.com/$REPO/releases/tag/${body.optString("tag_name")}" }
        return Info(
            currentVersion = current,
            latestVersion = latest.ifBlank { current },
            available = latest.isNotBlank() && newer(latest, current),
            name = body.optString("name").ifBlank { "v$latest" },
            notes = body.optString("body").trim(),
            htmlUrl = html,
            assetName = asset?.optString("name").orEmpty(),
            assetUrl = asset?.optString("browser_download_url").orEmpty(),
        )
    }

    fun toJson(info: Info, ok: Boolean = true, message: String = ""): String {
        return JSONObject()
            .put("ok", ok)
            .put("message", message)
            .put("currentVersion", info.currentVersion)
            .put("latestVersion", info.latestVersion)
            .put("available", info.available)
            .put("name", info.name)
            .put("notes", info.notes)
            .put("htmlUrl", info.htmlUrl)
            .put("assetName", info.assetName)
            .put("assetUrl", info.assetUrl)
            .put("repo", REPO)
            .toString()
    }

    fun download(info: Info, dir: File): File {
        if (info.assetUrl.isBlank()) throw IllegalStateException("Release 里没有 Android 安装包")
        val name = info.assetName.ifBlank { "herdr-plus-remote.apk" }.substringAfterLast('/').ifBlank { "herdr-plus-remote.apk" }
        dir.mkdirs()
        val dest = File(dir, name)
        val client = OkHttpClient.Builder().callTimeout(90, TimeUnit.SECONDS).followRedirects(true).build()
        val request = Request.Builder().url(info.assetUrl).header("Accept", "application/octet-stream").header("User-Agent", "herdr-plus/${info.currentVersion}").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("下载失败 HTTP ${response.code}")
            dest.outputStream().use { out -> response.body?.byteStream()?.copyTo(out) ?: throw IllegalStateException("安装包为空") }
        }
        if (dest.length() < 1024) throw IllegalStateException("安装包不完整")
        return dest
    }

    fun install(activity: Activity, file: File): String {
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(settings)
            return JSONObject().put("ok", false).put("needsPermission", true).put("message", "请允许安装未知应用，然后再次点下载安装").toString()
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        return JSONObject().put("ok", true).put("message", "已打开安装包").toString()
    }

    private fun pickApk(assets: JSONArray): JSONObject? {
        var fallback: JSONObject? = null
        for (i in 0 until assets.length()) {
            val item = assets.optJSONObject(i) ?: continue
            val name = item.optString("name").lowercase()
            if (!name.endsWith(".apk")) continue
            if (name.contains("android") || name.contains("herdr-plus-remote")) return item
            if (fallback == null) fallback = item
        }
        return fallback
    }

    private fun newer(latest: String, current: String): Boolean {
        val a = parts(latest) ?: return false
        val b = parts(current) ?: return false
        return a[0] > b[0] || (a[0] == b[0] && (a[1] > b[1] || (a[1] == b[1] && a[2] > b[2])))
    }

    private fun parts(raw: String): IntArray? {
        val core = raw.trim().removePrefix("v").removePrefix("V").substringBefore("-").substringBefore("+")
        val bits = core.split(".")
        if (bits.isEmpty() || bits[0].toIntOrNull() == null) return null
        return intArrayOf(bits[0].toInt(), bits.getOrNull(1)?.toIntOrNull() ?: 0, bits.getOrNull(2)?.toIntOrNull() ?: 0)
    }

    private fun get(url: String): JSONObject? {
        return try {
            val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
            val request = Request.Builder()
                .url(url)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("User-Agent", "herdr-plus")
                .build()
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (response.code == 404) return null
                if (!response.isSuccessful) throw IllegalStateException("GitHub HTTP ${response.code}")
                JSONObject(text)
            }
        } catch (err: Exception) {
            JSONObject().put("message", err.message ?: "检查更新失败")
        }
    }
}
