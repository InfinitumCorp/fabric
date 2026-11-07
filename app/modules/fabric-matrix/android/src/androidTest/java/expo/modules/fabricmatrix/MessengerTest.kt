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
import org.matrix.rustcomponents.sdk.*
import java.io.File

/** Stage 5 bridge operations against local Synapse with two real SDK clients (A = app user, B = test peer). */
@RunWith(AndroidJUnit4::class)
class MessengerTest {
  @get:Rule val timeout: Timeout = Timeout.seconds(200)
  private val args = InstrumentationRegistry.getArguments()
  private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
  private val hs = args.getString("hs")!!
  private val ea = MatrixEngine(File(ctx.noBackupFilesDir, "m-alice"), "m_alice_wrap")
  private val eb = MatrixEngine(File(ctx.noBackupFilesDir, "m-bob"), "m_bob_wrap")

  @After fun clean() = runBlocking { ea.logoutAndWipe(); eb.logoutAndWipe() }

  private suspend fun both(): Pair<Messenger, Messenger> {
    ea.login(hs, args.getString("aUser")!!, args.getString("aPw")!!)
    eb.login(hs, args.getString("bUser")!!, args.getString("bPw")!!)
    val a = ea.messenger!!; val b = eb.messenger!!
    a.start(); b.start()
    return a to b
  }

  private suspend fun refused(code: String, f: suspend () -> Unit) {
    try { f(); fail("expected refusal $code") } catch (e: SendRefusedException) { assertEquals(code, e.code) }
  }

  @Test fun dm_send_receive_and_refusals() = runBlocking {
    val (a, b) = both()
    val bId = eb.client!!.userId()
    val roomId = a.createDm(bId)
    withTimeout(60_000) { while (b.rooms().none { it.roomId == roomId && it.invited }) delay(300) }
    b.join(roomId)
    withTimeout(60_000) { while (a.peerStatus(roomId).identity == "unknown") delay(500) }
    val st = a.peerStatus(roomId)
    assertEquals(true, st.encrypted); assertEquals(bId, st.peer); assertEquals("unverified", st.identity)
    val marker = args.getString("marker")!! + "-m"
    a.send(roomId, marker)
    b.open(roomId)
    withTimeout(60_000) { while (b.messages(roomId).none { it.body == marker && !it.mine }) delay(400) }
    a.open(roomId)
    withTimeout(30_000) { while (a.messages(roomId).none { it.body == marker && it.mine && it.state == "sent" }) delay(400) }

    // Room with no peer: identity cannot be resolved, so the bridge refuses.
    val lonely = ea.client!!.createRoom(CreateRoomParameters(name = null, topic = null, isEncrypted = true, isDirect = false,
      visibility = RoomVisibility.Private, preset = RoomPreset.PRIVATE_CHAT, invite = null, avatar = null,
      powerLevelContentOverride = null, joinRuleOverride = null, historyVisibilityOverride = null, canonicalAlias = null, isSpace = false))
    // Until sync delivers m.room.encryption the room reads as not encrypted, which already refuses (fail closed).
    withTimeout(30_000) { while (ea.client!!.getRoom(lonely) == null || a.peerStatus(lonely).encrypted != true) delay(300) }
    refused("identity_unknown") { a.send(lonely, "x") }

    // Asking for an unencrypted room still yields an encrypted one: local Synapse sets
    // encryption_enabled_by_default_for_room_type=all. The not_encrypted refusal is covered by core rules tests.
    val plain = ea.client!!.createRoom(CreateRoomParameters(name = null, topic = null, isEncrypted = false, isDirect = false,
      visibility = RoomVisibility.Private, preset = RoomPreset.PRIVATE_CHAT, invite = null, avatar = null,
      powerLevelContentOverride = null, joinRuleOverride = null, historyVisibilityOverride = null, canonicalAlias = null, isSpace = false))
    withTimeout(30_000) { while (ea.client!!.getRoom(plain) == null || a.peerStatus(plain).encrypted != true) delay(300) }
    refused("bad_text") { a.send(roomId, "") }
    try { a.createDm("bob"); fail("bad id accepted") } catch (_: IllegalArgumentException) {}
  }
}
