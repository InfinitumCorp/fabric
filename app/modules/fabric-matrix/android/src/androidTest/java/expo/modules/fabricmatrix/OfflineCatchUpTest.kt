package expo.modules.fabricmatrix

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout
import org.junit.runner.RunWith
import java.io.File

/**
 * Offline catch-up across real process death. Run as three separate `am instrument` invocations
 * (each one is a new process): setup → peerSend (A not running) → catchUp (A restores, sees B's message, wipes).
 */
@RunWith(AndroidJUnit4::class)
class OfflineCatchUpTest {
  @get:Rule val timeout: Timeout = Timeout.seconds(150)
  private val args = InstrumentationRegistry.getArguments()
  private val dir = InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir
  private val hs = args.getString("hs")!!
  private val roomFile = File(dir, "offline-room")
  private val ea = MatrixEngine(File(dir, "o-alice"), "o_alice_wrap")
  private val eb = MatrixEngine(File(dir, "o-bob"), "o_bob_wrap")
  private val marker get() = args.getString("marker")!! + "-offline"

  @Test fun setup() = runBlocking {
    ea.logoutAndWipe(); eb.logoutAndWipe()
    ea.login(hs, args.getString("aUser")!!, args.getString("aPw")!!); eb.login(hs, args.getString("bUser")!!, args.getString("bPw")!!)
    val a = ea.messenger!!; val b = eb.messenger!!; a.start(); b.start()
    val room = a.createDm(eb.client!!.userId())
    withTimeout(60_000) { while (b.rooms().none { it.roomId == room && it.invited }) delay(300) }
    b.join(room)
    withTimeout(60_000) { while (a.peerStatus(room).identity == "unknown") delay(300) }
    a.stop(); b.stop()
    roomFile.writeText(room)
  }

  @Test fun peerSend() = runBlocking {
    val room = roomFile.readText()
    assertNotNull(eb.restore(hs)); val b = eb.messenger!!; b.start()
    withTimeout(60_000) { while (b.peerStatus(room).identity == "unknown") delay(300) }
    b.send(room, marker)
    b.open(room)
    withTimeout(60_000) { while (b.messages(room).none { it.body == marker && it.state == "sent" }) delay(300) }
    b.stop()
  }

  @Test fun catchUp() = runBlocking {
    val room = roomFile.readText()
    try {
      assertNotNull(ea.restore(hs)); val a = ea.messenger!!; a.start()
      withTimeout(90_000) {
        while (true) {
          try { a.open(room) } catch (_: Exception) {}
          if (a.messages(room).any { !it.mine && it.body == marker }) break
          delay(500)
        }
      }
    } finally { ea.logoutAndWipe(); eb.restore(hs); eb.logoutAndWipe(); roomFile.delete() }
  }
}
