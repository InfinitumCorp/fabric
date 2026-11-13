package expo.modules.fabricmatrix

import android.content.Intent
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout
import org.junit.runner.RunWith

/** The native sign-in screen logs in through the SDK, delivers only ids, and is FLAG_SECURE. */
@RunWith(AndroidJUnit4::class)
class SignInActivityTest {
  @get:Rule val timeout: Timeout = Timeout.seconds(120)
  private val args = InstrumentationRegistry.getArguments()
  private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

  private fun fill(s: ActivityScenario<SignInActivity>, user: String, pw: String) = s.onActivity { a ->
    assertTrue(a.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
    a.findViewById<EditText>(SignInActivity.ID_USER).setText(user)
    a.findViewById<EditText>(SignInActivity.ID_PASSWORD).setText(pw)
    a.findViewById<Button>(SignInActivity.ID_SUBMIT).performClick()
    assertEquals("", a.findViewById<EditText>(SignInActivity.ID_PASSWORD).text.toString())
  }

  @Test fun wrongThenRightPassword() = runBlocking {
    Engines.get(ctx).logoutAndWipe()
    val d = CompletableDeferred<SessionIds?>(); Engines.pendingSignIn = d
    val intent = Intent(ctx, SignInActivity::class.java).putExtra(SignInActivity.EXTRA_HS, args.getString("hs"))
    ActivityScenario.launch<SignInActivity>(intent).use { s ->
      fill(s, args.getString("aUser")!!, "wrong-password-x")
      withTimeout(30_000) { while (true) { var t = ""; s.onActivity { t = it.findViewById<android.widget.TextView>(SignInActivity.ID_ERROR).text.toString() }; if (t.isNotEmpty()) break; kotlinx.coroutines.delay(200) } }
      assertFalse(d.isCompleted)
      fill(s, args.getString("aUser")!!, args.getString("aPw")!!)
      val ids = withTimeout(60_000) { d.await() }!!
      assertTrue(ids.userId.startsWith("@"))
    }
    assertNotNull(Engines.get(ctx).restore(args.getString("hs")!!))
    Engines.get(ctx).logoutAndWipe()
  }
}
