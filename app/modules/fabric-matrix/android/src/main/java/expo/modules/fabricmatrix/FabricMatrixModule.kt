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
  } catch (x: SendRefusedException) { throw CodedException(x.code, x.code, null)
  } catch (x: IllegalArgumentException) { throw CodedException("bad_input", "bad_input", null)
  } catch (x: Exception) { throw CodedException(code, code, null) }
  private fun m() = engine?.messenger ?: throw CodedException("not_signed_in", "not_signed_in", null)

  override fun definition() = ModuleDefinition {
    Name("FabricMatrix")
    // Stays false until the Stage 3 checklist passes on both platforms. JS must not offer messaging while false.
    // Android passed the Stage 3 native gate (emulator, 2026-11-07). iOS stays false until its own gate.
    // Device verification (SAS) is not wired yet; the UI states this and unknown identities cannot be sent to.
    Constant("encryptedMessaging") { true }
    Constant("deviceVerification") { false }
    AsyncFunction("restore") Coroutine { hs: String -> guarded("restore_failed") { e().restore(hs)?.let(::ids) } }
    AsyncFunction("login") Coroutine { hs: String, user: String, pw: String -> guarded("login_failed") { ids(e().login(hs, user, pw)) } }
    AsyncFunction("startSync") Coroutine { -> guarded("sync_failed") { m().start() } }
    AsyncFunction("rooms") Coroutine { -> guarded("rooms_failed") { m().rooms().map { mapOf("roomId" to it.roomId, "name" to it.name, "peer" to it.peer, "invited" to it.invited) } } }
    AsyncFunction("createDm") Coroutine { userId: String -> guarded("create_failed") { m().createDm(userId) } }
    AsyncFunction("join") Coroutine { roomId: String -> guarded("join_failed") { m().join(roomId) } }
    AsyncFunction("peerStatus") Coroutine { roomId: String -> guarded("status_failed") { m().peerStatus(roomId).let { mapOf("encrypted" to it.encrypted, "peer" to it.peer, "identity" to it.identity) } } }
    AsyncFunction("acknowledgeIdentityChange") Coroutine { roomId: String -> guarded("ack_failed") { m().acknowledgeIdentityChange(roomId) } }
    AsyncFunction("open") Coroutine { roomId: String -> guarded("open_failed") { m().open(roomId) } }
    AsyncFunction("messages") Coroutine { roomId: String -> guarded("messages_failed") { m().messages(roomId).map { mapOf("id" to it.id, "mine" to it.mine, "sender" to it.sender, "body" to it.body, "utd" to it.utd, "state" to it.state, "ts" to it.ts.toDouble()) } } }
    AsyncFunction("send") Coroutine { roomId: String, text: String -> guarded("send_failed") { m().send(roomId, text) } }
    AsyncFunction("logoutAndWipe") Coroutine { -> guarded("logout_failed") { e().logoutAndWipe() } }
  }
}
