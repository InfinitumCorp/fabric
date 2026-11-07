package expo.modules.fabricmatrix

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class FabricMatrixModule : Module() {
  private var engine: MatrixEngine? = null
  private fun e(): MatrixEngine {
    val ctx = appContext.reactContext ?: throw CodedException("bridge_unavailable", "no context", null)
    return engine ?: MatrixEngine(File(ctx.noBackupFilesDir, "fabric")).also { engine = it }
  }
  private fun ids(s: SessionIds) = mapOf("userId" to s.userId, "deviceId" to s.deviceId)

  // Errors reaching JS carry codes only, never SDK messages (which may contain server details).
  private suspend fun <T> guarded(code: String, f: suspend () -> T): T = try { f() } catch (x: StoreLockedException) {
    throw CodedException("store_locked", "store_locked", null)
  } catch (x: Exception) { throw CodedException(code, code, null) }

  override fun definition() = ModuleDefinition {
    Name("FabricMatrix")
    // Stays false until the Stage 3 checklist passes on both platforms. JS must not offer messaging while false.
    Constant("encryptedMessaging") { false }
    AsyncFunction("restore") Coroutine { hs: String -> guarded("restore_failed") { e().restore(hs)?.let(::ids) } }
    AsyncFunction("login") Coroutine { hs: String, user: String, pw: String -> guarded("login_failed") { ids(e().login(hs, user, pw)) } }
    AsyncFunction("logoutAndWipe") Coroutine { -> guarded("logout_failed") { e().logoutAndWipe() } }
  }
}
