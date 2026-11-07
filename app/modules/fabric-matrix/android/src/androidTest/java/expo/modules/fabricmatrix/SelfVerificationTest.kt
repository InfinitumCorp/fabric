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
import java.io.File

/**
 * Returning account on a new device. Fresh throwaway users per run (server/make-gate-users.sh):
 * device 1 is the owner's first device (its normal first sign-in creates the identity); the app device
 * signs in later, starts unverified, and is verified by device 1 via SAS. No identity is ever reset.
 */
@RunWith(AndroidJUnit4::class)
class SelfVerificationTest {
  companion object {
    init { try { org.matrix.rustcomponents.sdk.initPlatform(org.matrix.rustcomponents.sdk.TracingConfiguration(org.matrix.rustcomponents.sdk.LogLevel.DEBUG, emptyList(), emptyList(), true, null, null), false) } catch (_: Throwable) {} }
  }
  @get:Rule val timeout: Timeout = Timeout.seconds(300)
  private val args = InstrumentationRegistry.getArguments()
  private val dir = InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir
  private val hs = args.getString("hs")!!
  private val pair = GatePool.nextPair()
  private val cred = mapOf("oUser" to pair.first.user, "oPw" to pair.first.password, "pUser" to pair.second.user, "pPw" to pair.second.password)
  private val engines = ArrayList<MatrixEngine>()
  private fun engine(n: String) = MatrixEngine(File(dir, "sv-${pair.first.user}-$n"), "sv_${pair.first.user}_${n}_wrap").also { engines += it }

  @After fun clean() = runBlocking { engines.forEach { it.logoutAndWipe() } }

  private suspend fun until(ms: Long, what: String, f: suspend () -> Boolean) =
    try { withTimeout(ms) { while (!f()) delay(300) } } catch (e: Exception) { fail("timeout: $what") }

  private suspend fun signIn(e: MatrixEngine, u: String, pw: String): Messenger {
    e.login(hs, cred.getValue(u), cred.getValue(pw)); return e.messenger!!.also { it.start() }
  }

  private suspend fun toSas(newDev: Messenger, trusted: Messenger) {
    newDev.verifier.requestOwnDevice()
    until(120_000, "incoming on trusted device") { trusted.verifier.state.phase == "incoming" }
    trusted.verifier.acceptIncoming()
    until(120_000, "sas") { newDev.verifier.state.phase == "sas" && trusted.verifier.state.phase == "sas" }
    assertEquals(newDev.verifier.state.emojis, trusted.verifier.state.emojis)
  }

  @Test fun newDevice_verifiedByTrustedDevice_thenCanVerifyPeerAndSend_andSurvivesRestart() = runBlocking {
    val d1 = signIn(engine("owner1"), "oUser", "oPw")          // owner's first device: creates identity normally
    until(60_000, "first device trusted") { d1.verifier.ownDeviceVerified() }
    val peerE = engine("peer"); val peer = signIn(peerE, "pUser", "pPw")
    until(60_000, "peer trusted") { peer.verifier.ownDeviceVerified() }

    val appE = engine("app"); val app = signIn(appE, "oUser", "oPw")  // returning account, new device
    until(30_000, "app device state known") { appE.client!!.encryption().verificationState() != org.matrix.rustcomponents.sdk.VerificationState.UNKNOWN }
    assertFalse("new device must start unverified", app.verifier.ownDeviceVerified())
    val peerId = peerE.client!!.userId()
    try { app.verifier.requestUser(peerId); fail("verified a peer from an unverified device") } catch (e: SendRefusedException) { assertEquals("own_device_unverified", e.code) }

    toSas(app, d1)
    app.verifier.confirmMatch(); d1.verifier.confirmMatch()
    until(60_000, "done") { app.verifier.state.phase == "done" && d1.verifier.state.phase == "done" }
    until(60_000, "app device verified") { app.verifier.ownDeviceVerified() }

    // Restart of the app device: trust comes back from the encrypted crypto store.
    app.stop(); val again = MatrixEngine(File(dir, "sv-${pair.first.user}-app"), "sv_${pair.first.user}_app_wrap"); again.restore(hs)
    val app2 = again.messenger!!; app2.start()
    until(30_000, "verified after restore") { app2.verifier.ownDeviceVerified() }

    // Now the app device can verify the peer and send.
    val room = app2.createDm(peerId)
    until(60_000, "invite") { peer.rooms().any { it.roomId == room && it.invited } }
    peer.join(room)
    until(60_000, "peer identity") { app2.peerStatus(room).identity != "unknown" }
    app2.verifier.reset()
    app2.verifier.requestUser(peerId)
    until(120_000, "peer incoming") { peer.verifier.state.phase == "incoming" }
    peer.verifier.acceptIncoming()
    until(120_000, "peer sas") { app2.verifier.state.phase == "sas" && peer.verifier.state.phase == "sas" }
    app2.verifier.confirmMatch(); peer.verifier.confirmMatch()
    until(60_000, "peer verified") { app2.peerStatus(room).identity == "verified" }
    app2.send(room, "after-self-verification")
    app2.stop()
  }

  @Test fun newDevice_mismatch_and_cancel_stay_unverified() = runBlocking {
    val d1 = signIn(engine("owner1"), "oUser", "oPw")
    until(60_000, "first device trusted") { d1.verifier.ownDeviceVerified() }
    val appE = engine("app"); val app = signIn(appE, "oUser", "oPw")
    toSas(app, d1)
    app.verifier.reportMismatch()
    until(60_000, "cancelled") { app.verifier.state.phase == "cancelled" && d1.verifier.state.phase == "cancelled" }
    assertFalse(app.verifier.ownDeviceVerified())
    app.verifier.reset(); d1.verifier.reset()
    app.verifier.requestOwnDevice()
    until(120_000, "incoming 2") { d1.verifier.state.phase == "incoming" }
    app.verifier.cancel()
    until(60_000, "cancel seen") { d1.verifier.state.phase == "cancelled" }
    assertFalse(app.verifier.ownDeviceVerified())
  }
}
