package com.uasier.herdrplus

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

object PinnedHttp {
    fun post(wsUrl: String, path: String, body: String, pin: String): String {
        return try {
            val root = wsUrl.substringBefore("/v1/ws")
                .replace("wss://", "https://")
                .replace("ws://", "http://")
            val request = Request.Builder()
                .url(root + path)
                .post(body.ifBlank { "{}" }.toRequestBody("application/json".toMediaType()))
                .build()
            client(pin).newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (text.isBlank()) """{"ok":false,"message":"HTTP ${response.code}"}""" else text
            }
        } catch (err: Exception) {
            """{"ok":false,"message":${json(err.message ?: "请求失败")}}"""
        }
    }

    private fun client(pin: String): OkHttpClient {
        val expected = pin.filter { !it.isWhitespace() && it != ':' }
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (expected.length != 64 || chain.isEmpty()) throw IllegalArgumentException("证书指纹无效")
                val digest = MessageDigest.getInstance("SHA-256").digest(chain[0].encoded)
                val hex = digest.joinToString("") { "%02x".format(it) }
                if (!hex.equals(expected, ignoreCase = true)) throw IllegalArgumentException("证书指纹不匹配")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val ssl = SSLContext.getInstance("TLS")
        ssl.init(null, arrayOf(trust), SecureRandom())
        return OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, trust)
            .hostnameVerifier { _, _ -> true }
            .build()
    }

    private fun json(raw: String): String {
        return "\"" + raw.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    }
}
