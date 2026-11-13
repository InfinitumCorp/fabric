package expo.modules.fabricmatrix

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout
import org.junit.runner.RunWith
import java.io.File

/**
 * Manual UI gate helper (run only by scripts, not by the app): signs in the test peer B with a real SDK client,
 * accepts invites, waits for a message whose body is the given marker, then replies "echo:<marker>".
 */
@RunWith(AndroidJUnit4::class)
class PeerEchoTest {
  @get:Rule val timeout: Timeout = Timeout.seconds(220)
  private val args = InstrumentationRegistry.getArguments()
  private val eb = MatrixEngine(File(InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir, "p-bob"), "p_bob_wrap")

  @After fun clean() = runBlocking { eb.logoutAndWipe() }

  @Test fun echo() = runBlocking {
    eb.login(args.getString("hs")!!, args.getString("bUser")!!, args.getString("bPw")!!)
    val b = eb.messenger!!; b.start()
    val marker = args.getString("marker")!! + "-ui"
    android.util.Log.i("FabricTest", "PEER_READY")
    withTimeout(200_000) {
      while (true) {
        for (r in b.rooms()) {
          if (r.invited) try { b.join(r.roomId) } catch (_: Exception) {}
          else {
            b.open(r.roomId)
            if (b.messages(r.roomId).any { !it.mine && it.body == marker }) {
              b.send(r.roomId, "echo:$marker"); android.util.Log.i("FabricTest", "PEER_ECHOED"); return@withTimeout
            }
          }
        }
        delay(1000)
      }
    }
    delay(5000)
  }
}
