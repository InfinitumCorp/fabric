package expo.modules.fabricmatrix

import android.content.Intent
import android.view.WindowManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * JS contract. Nothing here accepts a password or returns a token or key: sign-in happens in SignInActivity.
 * Values crossing to JS: user/device/room/event ids, display names, message bodies the user can already see,
 * status codes and SAS emoji (public by design). Errors carry codes only.
 */
class FabricMatrixModule : Module() {
  private fun e(): MatrixEngine {
    val ctx = appContext.reactContext ?: throw CodedException("bridge_unavailable", "bridge_unavailable", null)
    return Engines.get(ctx)
  }
  private fun ids(s: SessionIds) = mapOf("userId" to s.userId, "deviceId" to s.deviceId)
  private fun m() = e().messenger ?: throw CodedException("not_signed_in", "not_signed_in", null)

  private suspend fun <T> guarded(code: String, f: suspend () -> T): T = try { f() } catch (x: StoreLockedException) {
    throw CodedException("store_locked", "store_locked", null)
  } catch (x: SendRefusedException) { throw CodedException(x.code, x.code, null)
  } catch (x: IllegalArgumentException) { throw CodedException("bad_input", "bad_input", null)
  } catch (x: CodedException) { throw x
  } catch (x: Exception) { throw CodedException(code, code, null) }

  override fun definition() = ModuleDefinition {
    Name("FabricMatrix")
    // Android passed the native gate on the emulator. iOS stays false until its own gate.
    Constant("encryptedMessaging") { true }
    // True only because SAS verification is exercised against a real second SDK client (VerificationTest).
    Constant("deviceVerification") { true }

    OnCreate { setSecure() }
    OnActivityEntersForeground { setSecure() }

    AsyncFunction("restore") Coroutine { hs: String -> guarded("restore_failed") { e().restore(hs)?.let(::ids) } }
    /** Opens the native sign-in screen. Resolves with ids, or null if the user backed out. */
    AsyncFunction("signIn") Coroutine { hs: String ->
      guarded("login_failed") {
        val act = appContext.currentActivity ?: throw CodedException("bridge_unavailable", "bridge_unavailable", null)
        val d = CompletableDeferred<SessionIds?>()
        Engines.pendingSignIn = d
        withContext(Dispatchers.Main) { act.startActivity(Intent(act, SignInActivity::class.java).putExtra(SignInActivity.EXTRA_HS, hs)) }
        d.await()?.let(::ids)
      }
    }
    AsyncFunction("logoutAndWipe") Coroutine { -> guarded("logout_failed") { e().logoutAndWipe() } }
    AsyncFunction("startSync") Coroutine { -> guarded("sync_failed") { m().start() } }
    AsyncFunction("rooms") Coroutine { -> guarded("rooms_failed") { m().rooms().map { mapOf("roomId" to it.roomId, "name" to it.name, "peer" to it.peer, "invited" to it.invited) } } }
    AsyncFunction("createDm") Coroutine { userId: String -> guarded("create_failed") { m().createDm(userId) } }
    AsyncFunction("join") Coroutine { roomId: String -> guarded("join_failed") { m().join(roomId) } }
    AsyncFunction("peerStatus") Coroutine { roomId: String -> guarded("status_failed") { m().peerStatus(roomId).let { mapOf("encrypted" to it.encrypted, "peer" to it.peer, "identity" to it.identity) } } }
    AsyncFunction("acknowledgeIdentityChange") Coroutine { roomId: String -> guarded("ack_failed") { m().acknowledgeIdentityChange(roomId) } }
    AsyncFunction("open") Coroutine { roomId: String -> guarded("open_failed") { m().open(roomId) } }
    AsyncFunction("messages") Coroutine { roomId: String -> guarded("messages_failed") { m().messages(roomId).map { mapOf("id" to it.id, "mine" to it.mine, "sender" to it.sender, "body" to it.body, "utd" to it.utd, "state" to it.state, "ts" to it.ts.toDouble()) } } }
    AsyncFunction("send") Coroutine { roomId: String, text: String -> guarded("send_failed") { m().send(roomId, text) } }
    AsyncFunction("block") Coroutine { userId: String -> guarded("block_failed") { m().block(userId) } }
    AsyncFunction("unblock") Coroutine { userId: String -> guarded("block_failed") { m().unblock(userId) } }
    AsyncFunction("blocked") Coroutine { -> guarded("block_failed") { m().blocked() } }
    AsyncFunction("report") Coroutine { roomId: String, eventId: String, reason: String -> guarded("report_failed") { m().report(roomId, eventId, reason) } }
    AsyncFunction("verificationState") Coroutine { -> guarded("verify_failed") { m().verifier.state.let { mapOf("phase" to it.phase, "other" to it.other, "emojis" to it.emojis.map { (s, d) -> mapOf("symbol" to s, "description" to d) }) } } }
    AsyncFunction("verifyUser") Coroutine { userId: String -> guarded("verify_failed") { m().verifier.requestUser(userId) } }
    AsyncFunction("verifyAccept") Coroutine { -> guarded("verify_failed") { m().verifier.acceptIncoming() } }
    AsyncFunction("verifyConfirm") Coroutine { -> guarded("verify_failed") { m().verifier.confirmMatch() } }
    AsyncFunction("verifyMismatch") Coroutine { -> guarded("verify_failed") { m().verifier.reportMismatch() } }
    AsyncFunction("verifyCancel") Coroutine { -> guarded("verify_failed") { m().verifier.cancel() } }
    AsyncFunction("verifyReset") Coroutine { -> guarded("verify_failed") { m().verifier.reset() } }
  }

  // Spec section 6: message screens are FLAG_SECURE (no screenshots, blank recents preview).
  private fun setSecure() {
    appContext.currentActivity?.let { a -> a.runOnUiThread { a.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) } }
  }
}
