package expo.modules.fabricmatrix

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout
import org.junit.runner.RunWith
import org.matrix.rustcomponents.sdk.LogLevel
import org.matrix.rustcomponents.sdk.TracingConfiguration
import org.matrix.rustcomponents.sdk.initPlatform
import java.io.File

/**
 * Block then unblock on a live encrypted DM. Drives the same Messenger calls the UI uses
 * (open, messages, block, unblock, open again) with two real SDK clients. History must come back
 * from the server with the same event ids; the test does not wipe the store or sign in again.
 *
 * Run on a device or emulator against local Synapse (GatePool accounts):
 *   app/scripts/run-gate-tests.sh BlockTimelineTest
 */
@RunWith(AndroidJUnit4::class)
class BlockTimelineTest {
  companion object {
    init { try { initPlatform(TracingConfiguration(LogLevel.DEBUG, emptyList(), emptyList(), true, null, null), false) } catch (_: Throwable) {} }
  }

  @get:Rule val timeout: Timeout = Timeout.seconds(300)
  private val args = InstrumentationRegistry.getArguments()
  private val dir = InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir
  private val hs = args.getString("hs")!!
  private val pair = GatePool.nextPair()
  private val ea = MatrixEngine(File(dir, "blk-${pair.first.user}-a"), "blk_${pair.first.user}_a_wrap")
  private val eb = MatrixEngine(File(dir, "blk-${pair.first.user}-b"), "blk_${pair.first.user}_b_wrap")

  @After fun clean() = runBlocking { ea.logoutAndWipe(); eb.logoutAndWipe() }

  private suspend fun until(ms: Long, what: String, f: suspend () -> Boolean) =
    try { withTimeout(ms) { while (!f()) delay(300) } } catch (e: Exception) { fail("timeout: $what") }

  @Test fun block_hides_peer_and_unblock_restores_same_events() = runBlocking {
    ea.login(hs, pair.first.user, pair.first.password)
    eb.login(hs, pair.second.user, pair.second.password)
    val device = ea.client!!.deviceId()
    val bId = eb.client!!.userId()
    val a = ea.messenger!!; val b = eb.messenger!!
    a.start(); b.start()
    val room = a.createDm(bId)
    until(60_000, "invite") { b.rooms().any { it.roomId == room && it.invited } }
    b.join(room)
    until(60_000, "identity") { a.peerStatus(room).identity != "unknown" && b.peerStatus(room).identity != "unknown" }
    assertEquals(true, a.peerStatus(room).encrypted)

    val own = "owner-before-block"
    val peer = "peer-before-block"
    val during = "peer-while-blocked"
    val after = "peer-after-unblock"
    a.open(room); b.open(room)
    a.send(room, own)
    until(60_000, "own echo") { a.messages(room).any { it.mine && it.body == own && it.state == "sent" && it.id.startsWith("$") } }
    b.send(room, peer)
    until(60_000, "peer visible") { a.messages(room).any { !it.mine && it.body == peer && it.id.startsWith("$") } }
    val ownId = a.messages(room).first { it.body == own }.id
    val peerId = a.messages(room).first { it.body == peer }.id

    a.block(bId)
    until(60_000, "blocked list") { a.blocked().contains(bId) }
    // Contact -> back to the conversation, the same path as the UI.
    until(60_000, "peer hidden, own message kept") {
      a.open(room)
      val m = a.messages(room)
      m.any { it.id == ownId } && m.none { it.id == peerId || it.body == peer }
    }

    b.send(room, during)
    until(60_000, "peer sent while blocked") { b.messages(room).any { it.mine && it.body == during && it.state == "sent" } }
    val hiddenUntil = System.currentTimeMillis() + 4_000
    while (System.currentTimeMillis() < hiddenUntil) {
      assertTrue(a.messages(room).none { it.body == during })
      delay(250)
    }

    a.unblock(bId)
    until(60_000, "ignore list cleared") { !a.blocked().contains(bId) }
    // Settings -> Unblock, then reopen. Polling open() is that reopen, including when the
    // cache clear arrives after the screen is already open.
    until(90_000, "prior timeline restored") {
      a.open(room)
      val m = a.messages(room)
      m.any { it.id == ownId && it.body == own } &&
        m.any { it.id == peerId && it.body == peer } &&
        m.any { !it.mine && it.body == during } &&
        m.map { it.id }.distinct().size == m.size
    }

    b.send(room, after)
    until(60_000, "fresh message after unblock") { a.messages(room).any { !it.mine && it.body == after } }
    val restored = a.messages(room)
    assertTrue(restored.any { it.id == ownId && it.body == own })
    assertTrue(restored.any { it.id == peerId && it.body == peer })
    assertEquals(true, a.peerStatus(room).encrypted)
    assertEquals(device, ea.client!!.deviceId())
    assertTrue(a.rooms().any { it.roomId == room && !it.invited })
  }
}
