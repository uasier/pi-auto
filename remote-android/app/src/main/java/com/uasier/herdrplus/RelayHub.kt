package com.uasier.herdrplus

import java.util.ArrayDeque

object RelayHub {
    @Volatile var resumed = false
    var listener: ((String) -> Unit)? = null
    var onVisible: ((Boolean) -> Unit)? = null

    fun setVisible(visible: Boolean) {
        resumed = visible
        onVisible?.invoke(visible)
    }
    private val pending = ArrayDeque<String>()

    fun emit(text: String) {
        val callback = listener
        if (resumed && callback != null) {
            callback(text)
        } else {
            synchronized(pending) {
                if (pending.size >= 40) {
                    pending.clear()
                    pending.addLast("""{"type":"channel.resync"}""")
                }
                pending.addLast(text)
            }
        }
    }

    fun flush() {
        val callback = listener ?: return
        val copy = synchronized(pending) {
            val items = pending.toList()
            pending.clear()
            items
        }
        copy.forEach(callback)
    }
}
