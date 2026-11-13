package expo.modules.fabricmatrix

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import java.io.File

/** One engine per process, shared by the JS module and the native sign-in screen. */
object Engines {
  @Volatile private var engine: MatrixEngine? = null
  fun get(ctx: Context): MatrixEngine = engine ?: synchronized(this) {
    engine ?: MatrixEngine(File(ctx.applicationContext.noBackupFilesDir, "fabric")).also { engine = it }
  }
  /** Completed by SignInActivity with the session ids (never the password or token), or null if the user backed out. */
  @Volatile var pendingSignIn: CompletableDeferred<SessionIds?>? = null
}
