package com.uasier.herdrplus

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

data class ChannelStatus(
    val title: String,
    val text: String,
    val lines: List<String>,
    val connected: Boolean,
    val reconnecting: Boolean,
    val since: Long,
)

object Notifier {
    const val STATUS_ID = 7
    private const val HOST_ID = 8
    private const val LOGIN_ID = 9
    private const val STATUS = "herdr_status_v3"
    private const val IDLE = "herdr_idle_v3"
    private const val ATTENTION = "herdr_attention_v3"
    private val posted = linkedSetOf<String>()

    fun ensure(context: Context) {
        val manager = manager(context)
        listOf("channel", "herdr_status_v2", "herdr_alerts_v2", "herdr_quiet_v2").forEach {
            manager.deleteNotificationChannel(it)
        }
        if (Build.VERSION.SDK_INT < 26) return
        manager.createNotificationChannel(NotificationChannel(STATUS, "通道状态", NotificationManager.IMPORTANCE_LOW).apply {
            description = "常驻通知，只显示连接和会话概况"
            setShowBadge(false)
        })
        manager.createNotificationChannel(NotificationChannel(IDLE, "可以继续", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "会话空闲，可以发下一句"
            setShowBadge(true)
        })
        manager.createNotificationChannel(NotificationChannel(ATTENTION, "需要处理", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "等待确认、电脑断开或登录失效"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 40, 40, 40)
        })
    }

    fun foreground(context: Context, status: ChannelStatus): Notification {
        return base(context, STATUS, status.title, status.text)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setStyle(inbox(status))
            .setWhen(if (status.connected) status.since else System.currentTimeMillis())
            .setShowWhen(false)
            .setProgress(0, 0, status.reconnecting)
            .addAction(0, "打开", openIntent(context, null, 1))
            .build()
    }

    fun updateForeground(context: Context, status: ChannelStatus) {
        manager(context).notify(STATUS_ID, foreground(context, status))
    }

    fun session(context: Context, title: String, body: String, paneId: String, attention: Boolean, canContinue: Boolean) {
        posted += paneId
        val channel = if (attention) ATTENTION else IDLE
        val id = paneNoticeId(paneId)
        val notice = base(context, channel, title, body)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body).setBigContentTitle(title))
            .setContentIntent(openIntent(context, paneId, 20 + id))
            .addAction(0, "查看", openIntent(context, paneId, 40 + id))
        if (canContinue) {
            notice.addAction(0, "继续", serviceIntent(context, RelayService.ACTION_NUDGE, paneId, 60 + id))
        }
        manager(context).notify(id, notice.build())
    }

    fun hostDown(context: Context) {
        attention(context, "电脑已断开", "herdr+ 不在线，会话已暂停")
    }

    fun attention(context: Context, title: String, body: String) {
        once(context, HOST_ID, ATTENTION, title, body, null)
    }

    fun loginExpired(context: Context, detail: String) {
        once(context, LOGIN_ID, ATTENTION, "登录已失效", detail.ifBlank { "请重新用 GitHub 登录" }, null)
    }

    fun cancelPane(context: Context, paneId: String) {
        posted.remove(paneId)
        manager(context).cancel(paneNoticeId(paneId))
    }

    fun clearTransient(context: Context) {
        manager(context).cancel(HOST_ID)
        manager(context).cancel(LOGIN_ID)
    }

    fun clearAttention(context: Context) {
        posted.toList().forEach { cancelPane(context, it) }
        clearTransient(context)
    }

    private fun once(context: Context, id: Int, channel: String, title: String, body: String, paneId: String?) {
        val notice = base(context, channel, title, body)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body).setBigContentTitle(title))
            .setContentIntent(openIntent(context, paneId, 80 + id))
        manager(context).notify(id, notice.build())
    }

    private fun paneNoticeId(paneId: String) = 3000 + (paneId.hashCode() and 0x7fff)

    private fun inbox(status: ChannelStatus): NotificationCompat.InboxStyle {
        val style = NotificationCompat.InboxStyle().setBigContentTitle(status.title).setSummaryText(status.text)
        status.lines.take(5).forEach { style.addLine(it) }
        if (status.lines.size > 5) style.addLine("还有 ${status.lines.size - 5} 个会话")
        return style
    }

    private fun base(context: Context, channel: String, title: String, text: String): NotificationCompat.Builder {
        return NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_terminal)
            .setColor(0xFF8AA4C2.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openIntent(context, null, 1))
    }

    private fun openIntent(context: Context, paneId: String?, request: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (!paneId.isNullOrBlank()) intent.putExtra(RelayService.EXTRA_PANE, paneId)
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun serviceIntent(context: Context, action: String, paneId: String?, request: Int): PendingIntent {
        val intent = Intent(context, RelayService::class.java).setAction(action)
        if (!paneId.isNullOrBlank()) intent.putExtra(RelayService.EXTRA_PANE, paneId)
        return PendingIntent.getService(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun manager(context: Context): NotificationManager {
        return context.getSystemService(NotificationManager::class.java)
    }
}
