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
import java.security.KeyStore

/**
 * Runs the real Matrix Rust SDK against the local Synapse (Stage 2) from the emulator.
 * Args (instrumentation): hs, aUser, aPw, bUser, bPw, marker. Test accounts are throwaway local users.
 */
@RunWith(AndroidJUnit4::class)
class MatrixEngineTest {
  companion object {
    init { try { initPlatform(TracingConfiguration(LogLevel.DEBUG, emptyList(), emptyList(), true, null, null), false) } catch (_: Throwable) {} }
  }
  // Finite per-test bound so a stalled network call fails instead of hanging the run.
  @get:Rule val timeout: Timeout = Timeout.seconds(200)
  private val args = InstrumentationRegistry.getArguments()
  private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
  private val hs = args.getString("hs")!!
  private val rootA = File(ctx.noBackupFilesDir, "t-alice")
  private val rootB = File(ctx.noBackupFilesDir, "t-bob")
  private fun engA() = MatrixEngine(rootA, "t_alice_wrap")
  private fun engB() = MatrixEngine(rootB, "t_bob_wrap")

  @After fun clean() = runBlocking {
    engA().logoutAndWipe(); engB().logoutAndWipe()
  }

  private fun allFileBytes(root: File) = root.walk().filter { it.isFile }.map { it.readBytes() }

  @Test fun loginRestoreWipe_noSecretsInClearOnDisk() = runBlocking {
    val a = engA().login(hs, args.getString("aUser")!!, args.getString("aPw")!!)
    assertTrue(a.userId.startsWith("@"))
    // New engine instance = app restart. Restores the same device from Keystore-wrapped key + session.
    val r = engA().restore(hs)
    assertEquals(a, r)
    // matrix-sdk-sqlite keeps a normal SQLite file and encrypts keys/values with its StoreCipher
    // (keyed by our Keystore-wrapped key). So check contents, not the file header: no secret appears in clear.
    val dbs = File(rootA, "matrix").walk().filter { it.isFile && it.name.endsWith(".sqlite3") }.toList()
    assertTrue("expected sqlite stores", dbs.isNotEmpty())
    val engR = engA(); engR.restore(hs)
    val token = engR.client!!.session().accessToken.toByteArray()
    assertFalse("access token stored in clear", allFileBytes(rootA).any { contains(it, token) })
    assertFalse("user id stored in clear", allFileBytes(File(rootA, "matrix")).any { contains(it, a.userId.toByteArray()) })
    // No access token or password on disk in clear.
    val pw = args.getString("aPw")!!.toByteArray()
    assertFalse(allFileBytes(rootA).any { contains(it, pw) })
    engA().logoutAndWipe()
    assertFalse(File(rootA, "matrix").exists())
    assertFalse(KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.containsAlias("t_alice_wrap"))
    assertNull(engA().restore(hs))
  }

  @Test fun wrongPassword_leavesNothing() = runBlocking {
    try { engA().login(hs, args.getString("aUser")!!, "wrong-password-x"); fail("login succeeded") } catch (_: Exception) {}
    assertFalse(File(rootA, "matrix").exists())
    assertNull(engA().restore(hs))
  }

  @Test fun missingKeystoreKey_failsClosed() = runBlocking {
    engA().login(hs, args.getString("aUser")!!, args.getString("aPw")!!)
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry("t_alice_wrap")
    try { engA().restore(hs); fail("restored without key") } catch (_: StoreLockedException) {}
  }

  @Test fun missingWrappedKeyFile_failsClosed() = runBlocking {
    engA().login(hs, args.getString("aUser")!!, args.getString("aPw")!!)
    File(rootA, "vault/store.key.enc").delete()
    try { engA().restore(hs); fail("restored without key file") } catch (_: StoreLockedException) {}
  }

  @Test fun wrongStoreKey_cannotOpenStore() = runBlocking {
    engA().login(hs, args.getString("aUser")!!, args.getString("aPw")!!)
    val other = ByteArray(32) { 7 }
    try {
      ClientBuilder().homeserverUrl(hs)
        .sqliteStore(SqliteStoreBuilder(File(rootA, "matrix/data").path, File(rootA, "matrix/cache").path).key(other))
        .build()
      fail("store opened with wrong key")
    } catch (_: Exception) {}
  }

  @Test fun encryptedRoundTrip_aliceToBob() = runBlocking {
    val marker = args.getString("marker")!!
    val ea = engA(); val eb = engB()
    ea.login(hs, args.getString("aUser")!!, args.getString("aPw")!!)
    val b = eb.login(hs, args.getString("bUser")!!, args.getString("bPw")!!)
    val ca = ea.client!!; val cb = eb.client!!
    val sa = ca.syncService().finish(); val sb = cb.syncService().finish()
    sa.start(); sb.start()
    try {
      val roomId = ca.createRoom(CreateRoomParameters(
        name = null, topic = null, isEncrypted = true, isDirect = true, visibility = RoomVisibility.Private,
        preset = RoomPreset.TRUSTED_PRIVATE_CHAT, invite = listOf(b.userId), avatar = null,
        powerLevelContentOverride = null, joinRuleOverride = null, historyVisibilityOverride = null,
        canonicalAlias = null, isSpace = false))
      withTimeout(60_000) { while (cb.getRoom(roomId) == null) delay(300) }
      cb.joinRoomById(roomId)
      val ra = ca.getRoom(roomId)!!
      withTimeout(60_000) { while (ra.joinedMembersCount() < 2uL) delay(300) }
      assertTrue(ra.isEncrypted())
      val eventId = ra.sendRaw("m.room.message", """{"msgtype":"m.text","body":"$marker"}""", null)
      val rb = cb.getRoom(roomId)!!
      var body: String? = null
      withTimeout(60_000) {
        while (body == null) {
          val c = try { rb.loadOrFetchEvent(eventId).content() } catch (_: Exception) { null }
          val m = (c as? TimelineEventContent.MessageLike)?.content
          if (m is MessageLikeEventContent.RoomMessage) body = (m.messageType as? MessageType.Text)?.content?.body
          if (body == null) delay(500)
        }
      }
      assertEquals(marker, body)
      // Hand the ids to the host so it can inspect the server database.
      android.util.Log.i("FabricTest", "ROUNDTRIP_EVENT $eventId $roomId")
      for (root in listOf(rootA, rootB)) assertFalse(allFileBytes(root).any { contains(it, marker.toByteArray()) })
    } finally { sa.stop(); sb.stop() }
  }

  private fun contains(h: ByteArray, n: ByteArray): Boolean {
    outer@ for (i in 0..h.size - n.size) { for (j in n.indices) if (h[i + j] != n[j]) continue@outer; return true }
    return false
  }
}
