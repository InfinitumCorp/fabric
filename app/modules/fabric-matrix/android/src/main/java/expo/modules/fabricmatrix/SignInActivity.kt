package expo.modules.fabricmatrix

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Native sign-in. User name and password are read from these views and passed straight to the SDK.
 * Nothing here is sent to JavaScript except SessionIds. FLAG_SECURE blocks screenshots and recents previews.
 */
class SignInActivity : Activity() {
  companion object { const val EXTRA_HS = "hs"; const val ID_USER = 0x7f0f0001; const val ID_PASSWORD = 0x7f0f0002; const val ID_SUBMIT = 0x7f0f0003; const val ID_ERROR = 0x7f0f0004 }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var delivered = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    val hs = intent.getStringExtra(EXTRA_HS) ?: run { finishWith(null); return }
    val ink = Color.parseColor("#111820"); val muted = Color.parseColor("#52606b"); val accent = Color.parseColor("#2454dd")
    val dp = resources.displayMetrics.density
    fun label(t: String) = TextView(this).apply { text = t; setTextColor(muted); textSize = 13f; setPadding(0, (12 * dp).toInt(), 0, (6 * dp).toInt()) }
    fun field(id: Int, type: Int) = EditText(this).apply {
      this.id = id; inputType = type; setTextColor(ink); textSize = 15f; typeface = Typeface.SANS_SERIF
      setBackgroundResource(android.R.drawable.edit_text); isSaveEnabled = false
    }
    val user = field(ID_USER, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
    val pw = field(ID_PASSWORD, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD).apply {
      importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO
    }
    val error = TextView(this).apply { id = ID_ERROR; setTextColor(Color.parseColor("#a3261b")); textSize = 13f }
    val submit = Button(this).apply {
      id = ID_SUBMIT; text = "Sign in"; isAllCaps = false; setTextColor(Color.WHITE); setBackgroundColor(accent)
    }
    submit.setOnClickListener {
      val u = user.text.toString().trim()
      // Read once into a CharArray-backed String for the SDK call; the field is cleared immediately.
      val p = pw.text.toString(); pw.text.clear()
      if (u.isEmpty() || p.isEmpty()) { error.text = "Enter user name and password."; return@setOnClickListener }
      submit.isEnabled = false; error.text = ""; submit.text = "Signing in…"
      scope.launch {
        val r = try { withContext(Dispatchers.IO) { Engines.get(this@SignInActivity).login(hs, u, p) } }
          catch (_: StoreLockedException) { null.also { error.text = "Local data is locked. Sign out to wipe it." } }
          catch (_: IllegalStateException) { null.also { error.text = "Already signed in." } }
          catch (_: Exception) { null.also { error.text = "Sign-in failed. Check the user name and password." } }
        submit.isEnabled = true; submit.text = "Sign in"
        if (r != null) finishWith(r)
      }
    }
    setContentView(LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.WHITE); gravity = Gravity.TOP
      setPadding((20 * dp).toInt(), (48 * dp).toInt(), (20 * dp).toInt(), 0)
      addView(TextView(context).apply { text = "FabriC++"; setTextColor(ink); textSize = 32f; letterSpacing = -0.02f })
      addView(TextView(context).apply { text = "Sign in. Your password stays in this native screen."; setTextColor(muted); textSize = 14f })
      addView(TextView(context).apply { text = "Server: $hs"; setTextColor(muted); textSize = 12f; setPadding(0, (8 * dp).toInt(), 0, 0) })
      addView(label("User name")); addView(user, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      addView(label("Password")); addView(pw, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      addView(error)
      addView(submit, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = (16 * dp).toInt() })
    })
  }

  private fun finishWith(r: SessionIds?) {
    if (!delivered) { delivered = true; Engines.pendingSignIn?.complete(r) }
    finish()
  }

  override fun onDestroy() { if (isFinishing) finishWith(null); scope.cancel(); super.onDestroy() }
}
