package com.uasier.herdrplus

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RelayHubTest {
    private val received = mutableListOf<String>()

    @Before
    fun prepare() {
        RelayHub.onVisible = null
        RelayHub.listener = { received.add(it) }
        RelayHub.flush()
        received.clear()
        RelayHub.setVisible(false)
    }

    @After
    fun cleanup() {
        RelayHub.flush()
        RelayHub.listener = null
        RelayHub.onVisible = null
        RelayHub.setVisible(false)
    }

    @Test
    fun backgroundMessagesKeepTheirOrderUntilResume() {
        RelayHub.emit("选择 Mac")
        RelayHub.emit("会话列表")
        assertTrue(received.isEmpty())
        RelayHub.setVisible(true)
        RelayHub.flush()
        assertEquals(listOf("选择 Mac", "会话列表"), received)
        RelayHub.emit("实时更新")
        assertEquals("实时更新", received.last())
    }

    @Test
    fun overflowRequestsResynchronizationBeforeRemainingMessages() {
        repeat(45) { RelayHub.emit("增量 $it") }
        RelayHub.setVisible(true)
        RelayHub.flush()
        assertEquals("""{"type":"channel.resync"}""", received.first())
        assertEquals("增量 44", received.last())
        assertTrue(received.size <= 40)
        val count = received.size
        RelayHub.flush()
        assertEquals(count, received.size)
    }
}
