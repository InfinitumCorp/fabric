package expo.modules.fabricmatrix

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.matrix.rustcomponents.sdk.*

/**
 * SAS (emoji) user verification through the SDK's SessionVerificationController.
 * State is only what the SDK reports; "done" is set from didFinish, never by this code otherwise.
 * Phases: idle → requested | incoming → accepted → sas(emojis) → done | cancelled | failed.
 */
class Verifier(private val client: Client) {
  data class State(val phase: String, val other: String?, val emojis: List<Pair<String, String>>)
  @Volatile var state = State("idle", null, emptyList()); private set
  private var ctl: SessionVerificationController? = null
  private var incoming: SessionVerificationRequestDetails? = null
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  suspend fun attach() {
    if (ctl != null) return
    val c = client.getSessionVerificationController()
    c.setDelegate(object : SessionVerificationControllerDelegate {
      override fun didReceiveVerificationRequest(details: SessionVerificationRequestDetails) {
        incoming = details
        scope.launch {
          try { c.acknowledgeVerificationRequest(details.senderProfile.userId, details.flowId) } catch (_: Exception) {}
          state = State("incoming", details.senderProfile.userId, emptyList())
        }
      }
      override fun didAcceptVerificationRequest() {
        val wasRequester = state.phase == "requested"
        state = state.copy(phase = "accepted")
        if (wasRequester) scope.launch { try { c.startSasVerification() } catch (_: Exception) { state = state.copy(phase = "failed") } }
      }
      override fun didStartSasVerification() { state = state.copy(phase = "accepted") }
      override fun didReceiveVerificationData(data: SessionVerificationData) {
        val e = (data as? SessionVerificationData.Emojis)?.emojis?.map { it.symbol() to it.description() }
        // Only emoji SAS is offered; decimals are cancelled rather than shown half-supported.
        if (e == null) { scope.launch { try { c.cancelVerification() } catch (_: Exception) {} }; state = state.copy(phase = "cancelled"); return }
        state = state.copy(phase = "sas", emojis = e)
      }
      override fun didFail() { state = state.copy(phase = "failed", emojis = emptyList()) }
      override fun didCancel() { state = state.copy(phase = "cancelled", emojis = emptyList()) }
      override fun didFinish() { state = state.copy(phase = "done", emojis = emptyList()) }
    })
    ctl = c
  }

  private fun c() = ctl ?: throw SendRefusedException("verification_unavailable")
  /** False when this device is not cross-signed by its own identity (e.g. new sign-in on an account that already
   *  had one). The SDK cannot sign other users then, so verification is refused instead of failing half-way. */
  fun ownDeviceVerified() = client.encryption().verificationState() == VerificationState.VERIFIED

  suspend fun requestUser(userId: String) {
    if (!ownDeviceVerified()) throw SendRefusedException("own_device_unverified")
    attach(); state = State("requested", userId, emptyList()); c().requestUserVerification(userId) }
  suspend fun acceptIncoming() { if (!ownDeviceVerified()) throw SendRefusedException("own_device_unverified"); if (state.phase != "incoming") throw SendRefusedException("no_request"); c().acceptVerificationRequest() }
  /** User confirmed the emojis match on both devices. */
  suspend fun confirmMatch() { if (state.phase != "sas") throw SendRefusedException("no_sas"); c().approveVerification() }
  /** User says the emojis differ: the SDK cancels with a mismatch. */
  suspend fun reportMismatch() { if (state.phase != "sas") throw SendRefusedException("no_sas"); c().declineVerification() }
  suspend fun cancel() { try { c().cancelVerification() } finally { state = state.copy(phase = "cancelled", emojis = emptyList()) } }
  fun reset() { if (state.phase in setOf("done", "cancelled", "failed")) state = State("idle", null, emptyList()) }
}
