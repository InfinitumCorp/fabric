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

/** Peer SAS verification, mismatch, persistence and identity-change refusal. Only the identity-change step resets
 *  the PEER's identity, on purpose, to simulate a changed contact. */
/** SAS verification, mismatch, persistence and identity-change refusal with two real SDK clients. */
@RunWith(AndroidJUnit4::class)
class VerificationTest {
  @get:Rule val timeout: Timeout = Timeout.seconds(200)
  private val args = InstrumentationRegistry.getArguments()
  private val dir = InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir
  private val hs = args.getString("hs")!!
  private val ea = MatrixEngine(File(dir, "v-alice"), "v_alice_wrap")
  private val eb = MatrixEngine(File(dir, "v-bob"), "v_bob_wrap")

  @After fun clean() = runBlocking { ea.logoutAndWipe(); eb.logoutAndWipe() }

  private suspend fun until(ms: Long, what: String, f: suspend () -> Boolean) =
    try { withTimeout(ms) { while (!f()) delay(300) } } catch (e: Exception) { fail("timeout: $what") }

  private suspend fun setup(): Triple<Messenger, Messenger, String> {
    ea.login(hs, args.getString("oUser")!!, args.getString("oPw")!!)
    eb.login(hs, args.getString("pUser")!!, args.getString("pPw")!!)
    // Fresh throwaway users per run (run-gate-tests.sh): these are each account's first device, so the
    // normal first sign-in creates the identity. No reset here.
    val a = ea.messenger!!; val b = eb.messenger!!; a.start(); b.start()
    until(30_000, "own devices verified") { a.verifier.ownDeviceVerified() && b.verifier.ownDeviceVerified() }
    val bId = eb.client!!.userId()
    val room = a.createDm(bId)
    until(60_000, "invite") { b.rooms().any { it.roomId == room && it.invited } }
    b.join(room)
    until(60_000, "identity") { a.peerStatus(room).identity != "unknown" }
    return Triple(a, b, room)
  }

  private suspend fun resetOwn(e: MatrixEngine, pw: String) {
    val c = e.client!!
    val h = c.encryption().resetIdentity() ?: return
    val sess = (h.authType() as? CrossSigningResetAuthType.Uiaa)?.info?.session ?: ""
    h.reset(AuthData.Password(AuthDataPasswordDetails(c.userId(), pw, sess)))
  }

  private suspend fun toSas(a: Messenger, b: Messenger, bId: String) {
    a.verifier.requestUser(bId)
    until(60_000, "incoming") { b.verifier.state.phase == "incoming" }
    assertEquals(ea.client!!.userId(), b.verifier.state.other)
    b.verifier.acceptIncoming()
    until(120_000, "sas") { android.util.Log.i("FabricTest", "phases a=${a.verifier.state.phase} b=${b.verifier.state.phase}"); a.verifier.state.phase == "sas" && b.verifier.state.phase == "sas" }
    assertEquals(7, a.verifier.state.emojis.size)
    assertEquals(a.verifier.state.emojis, b.verifier.state.emojis)
  }

  @Test fun mismatch_cancels_and_leaves_unverified() = runBlocking {
    val (a, b, room) = setup()
    toSas(a, b, eb.client!!.userId())
    a.verifier.reportMismatch()
    until(30_000, "cancel") { a.verifier.state.phase == "cancelled" && b.verifier.state.phase == "cancelled" }
    assertEquals("unverified", a.peerStatus(room).identity)
  }

  @Test fun sas_match_verifies_persists_and_identity_change_blocks_until_acknowledged() = runBlocking {
    val (a, b, room) = setup()
    val bId = eb.client!!.userId()
    toSas(a, b, bId)
    a.verifier.confirmMatch(); b.verifier.confirmMatch()
    until(60_000, "done") { a.verifier.state.phase == "done" && b.verifier.state.phase == "done" }
    until(30_000, "verified") { a.peerStatus(room).identity == "verified" }

    // Restore in a fresh engine instance (app restart): verification state comes from the encrypted crypto store.
    a.stop(); val ea2 = MatrixEngine(File(dir, "v-alice"), "v_alice_wrap"); ea2.restore(hs)
    val a2 = ea2.messenger!!; a2.start()
    until(30_000, "verified after restore") { a2.peerStatus(room).identity == "verified" }

    // B resets its cryptographic identity (what a reinstall or compromised account looks like to A).
    resetOwn(eb, args.getString("pPw")!!)
    until(90_000, "violation") { a2.peerStatus(room).identity == "changed" }
    try { a2.send(room, "must-not-send"); fail("sent despite identity change") } catch (e: SendRefusedException) { assertEquals("identity_changed", e.code) }
    a2.acknowledgeIdentityChange(room)
    until(30_000, "acknowledged") { a2.peerStatus(room).identity == "unverified" }
    a2.send(room, "after-ack")
    a2.stop()
  }
}
