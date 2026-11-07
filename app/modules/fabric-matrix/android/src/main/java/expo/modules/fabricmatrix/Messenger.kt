package expo.modules.fabricmatrix

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.matrix.rustcomponents.sdk.*
import uniffi.matrix_sdk_base.EncryptionState
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class SendRefusedException(val code: String) : Exception(code)

data class PeerStatus(val encrypted: Boolean?, val peer: String?, val identity: String)
data class RoomSummary(val roomId: String, val name: String, val peer: String?, val invited: Boolean)
data class Msg(val id: String, val mine: Boolean, val sender: String, val body: String?, val utd: Boolean, val state: String, val ts: Long)

/**
 * 1:1 encrypted messaging on top of a signed-in MatrixEngine client, using only SDK APIs
 * (createRoom with encryption, Timeline.send, Encryption.userIdentity). No crypto is done here.
 * Sends are refused unless the room is encrypted and the peer identity is resolved and not changed.
 */
class Messenger(private val client: Client) {
  val verifier = Verifier(client)
  private var sync: SyncService? = null
  private val timelines = HashMap<String, OpenLine>()
  private val handles = ArrayList<TaskHandle>()
  /** SDK 26.10.23 clears every room event cache when the ignore list changes and emits TimelineDiff.Clear. Sync does not put the old events back; /messages back-pagination does. */
  private val ignoreEpoch = AtomicInteger(0)
  private val ignoreListenerArmed = AtomicBoolean(false)
  private var reloadParent: CompletableJob = SupervisorJob()
  private val refillMutex = Mutex()

  private class OpenLine(val timeline: Timeline, val items: MutableList<TimelineItem>) {
    val clears = AtomicInteger(0)
    val loadedAtClear = AtomicInteger(0)
  }

  suspend fun start() {
    if (sync == null) {
      if (!reloadParent.isActive) reloadParent = SupervisorJob()
      // Subscribe before sync so the first ignore-list echo is observed.
      handles += client.subscribeToIgnoredUsers(object : IgnoredUsersListener {
        override fun call(ignoredUserIds: List<String>) {
          // subscribeToIgnoredUsers invokes this once with the current list before returning.
          if (!ignoreListenerArmed.getAndSet(true)) return
          val epoch = ignoreEpoch.incrementAndGet()
          CoroutineScope(reloadParent + Dispatchers.Default).launch { restoreAfterIgnore(epoch) }
        }
      })
      sync = client.syncService().finish().also { it.start() }
    }
    verifier.attachInBackground()
  }

  /** Block = Matrix ignore list (server-side account data). The server then omits that user's non-state events. */
  suspend fun block(userId: String) = client.ignoreUser(userId)
  suspend fun unblock(userId: String) = client.unignoreUser(userId)
  suspend fun blocked(): List<String> = client.ignoredUsers()

  /**
   * Report one event to the homeserver administrators. Sends only the event id, room id and the
   * user's reason text; the server already holds the event as ciphertext. Called only after explicit consent in the UI.
   */
  suspend fun report(roomId: String, eventId: String, reason: String) {
    if (!eventId.startsWith("$") || reason.length > 500) throw SendRefusedException("bad_input")
    room(roomId).reportContent(eventId, reason.ifBlank { null })
  }

  suspend fun stop() {
    ignoreEpoch.incrementAndGet()
    reloadParent.cancel()
    handles.forEach { it.cancel() }; handles.clear()
    synchronized(timelines) { timelines.clear() }
    sync?.stop(); sync = null
    ignoreListenerArmed.set(false)
  }

  suspend fun rooms(): List<RoomSummary> = client.rooms().mapNotNull { r ->
    when (r.membership()) {
      Membership.JOINED -> RoomSummary(r.id(), r.displayName() ?: r.id(), peerOf(r), false)
      Membership.INVITED -> RoomSummary(r.id(), r.displayName() ?: r.id(), peerOf(r), true)
      else -> null
    }
  }

  private suspend fun peerOf(r: Room): String? = try {
    if (r.membership() == Membership.INVITED) r.inviter()?.userId
    else r.roomInfo().heroes.map { it.userId }.singleOrNull()
  } catch (_: Exception) { null }

  suspend fun createDm(userId: String): String {
    require(Regex("^@[a-z0-9._=\\-/+]+:[A-Za-z0-9.\\-]+(:[0-9]{1,5})?$").matches(userId)) { "bad_user_id" }
    return client.createRoom(CreateRoomParameters(
      name = null, topic = null, isEncrypted = true, isDirect = true, visibility = RoomVisibility.Private,
      preset = RoomPreset.TRUSTED_PRIVATE_CHAT, invite = listOf(userId), avatar = null,
      powerLevelContentOverride = null, joinRuleOverride = null, historyVisibilityOverride = null,
      canonicalAlias = null, isSpace = false))
  }

  suspend fun join(roomId: String) { room(roomId).join() }

  private fun room(roomId: String) = client.getRoom(roomId) ?: throw SendRefusedException("no_room")

  suspend fun peerStatus(roomId: String): PeerStatus {
    val r = room(roomId)
    val enc = when (r.roomInfo().encryptionState) {
      EncryptionState.ENCRYPTED -> true; EncryptionState.NOT_ENCRYPTED -> false; else -> null
    }
    val peer = peerOf(r) ?: return PeerStatus(enc, null, "unknown")
    val id = try { client.encryption().userIdentity(peer, true) } catch (_: Exception) { null }
    val identity = when {
      id == null -> "unknown"
      id.hasVerificationViolation() -> "changed"
      id.isVerified() -> "verified"
      else -> "unverified"
    }
    return PeerStatus(enc, peer, identity)
  }

  /** Withdraws the old verification after a verified peer's identity changed; sending is then allowed as unverified. */
  suspend fun acknowledgeIdentityChange(roomId: String) {
    val peer = peerStatus(roomId).peer ?: throw SendRefusedException("identity_unknown")
    client.encryption().userIdentity(peer, true)?.withdrawVerification() ?: throw SendRefusedException("identity_unknown")
  }

  suspend fun open(roomId: String) {
    val existing = synchronized(timelines) { timelines[roomId] }
    if (existing != null) {
      if (existing.clears.get() != existing.loadedAtClear.get()) refill(existing)
      return
    }
    val t = room(roomId).timeline()
    val items: MutableList<TimelineItem> = Collections.synchronizedList(ArrayList())
    val line = OpenLine(t, items)
    handles += t.addListener(object : TimelineListener {
      override fun onUpdate(diff: List<TimelineDiff>) = synchronized(items) {
        var sawClear = false
        for (d in diff) when (d) {
          is TimelineDiff.Append -> items.addAll(d.values)
          is TimelineDiff.PushBack -> items.add(d.value)
          is TimelineDiff.PushFront -> items.add(0, d.value)
          is TimelineDiff.Insert -> items.add(d.index.toInt(), d.value)
          is TimelineDiff.Set -> items[d.index.toInt()] = d.value
          is TimelineDiff.Remove -> items.removeAt(d.index.toInt())
          is TimelineDiff.Truncate -> while (items.size > d.length.toInt()) items.removeAt(items.size - 1)
          is TimelineDiff.PopBack -> if (items.isNotEmpty()) items.removeAt(items.size - 1)
          is TimelineDiff.PopFront -> if (items.isNotEmpty()) items.removeAt(0)
          is TimelineDiff.Clear -> { items.clear(); sawClear = true }
          is TimelineDiff.Reset -> { items.clear(); items.addAll(d.values) }
        }
        // Clear is the event-cache wipe after an ignore-list change, not a deletion of history.
        if (sawClear) line.clears.incrementAndGet()
      }
    })
    synchronized(timelines) { timelines[roomId] = line }
    try {
      t.paginateBackwards(30u)
      if (line.clears.get() == 0) line.loadedAtClear.set(0)
    } catch (e: CancellationException) { throw e } catch (_: Exception) {}
    if (line.clears.get() != line.loadedAtClear.get()) refill(line)
  }

  /**
   * After the SDK wipes open timelines for an ignore-list change, back-paginate once that Clear has landed.
   * While the user is blocked the server omits their events; after unblock the same call returns the prior timeline.
   */
  private suspend fun restoreAfterIgnore(epoch: Int) {
    val started = System.currentTimeMillis()
    val deadline = started + 20_000
    var lastRefill = 0L
    while (ignoreEpoch.get() == epoch && System.currentTimeMillis() < deadline) {
      val pending = synchronized(timelines) { timelines.values.filter { it.clears.get() != it.loadedAtClear.get() } }
      if (pending.isNotEmpty()) {
        for (line in pending) {
          if (ignoreEpoch.get() != epoch) return
          val before = line.loadedAtClear.get()
          refill(line)
          if (line.loadedAtClear.get() == before) delay(200)
        }
        lastRefill = System.currentTimeMillis()
        continue
      }
      val idle = synchronized(timelines) { timelines.isEmpty() }
      if (idle && lastRefill == 0L && System.currentTimeMillis() - started > 400) return
      if (lastRefill != 0L && System.currentTimeMillis() - lastRefill > 1_000) return
      delay(50)
    }
  }

  private suspend fun refill(line: OpenLine) {
    refillMutex.withLock {
      val seen = line.clears.get()
      if (line.loadedAtClear.get() == seen) return
      try {
        line.timeline.paginateBackwards(30u)
        if (line.clears.get() == seen) line.loadedAtClear.set(seen)
      } catch (e: CancellationException) { throw e } catch (_: Exception) {}
    }
  }

  fun messages(roomId: String): List<Msg> {
    val items = synchronized(timelines) { timelines[roomId]?.items } ?: return emptyList()
    return synchronized(items) { items.mapNotNull { it.asEvent() } }.mapNotNull { e ->
      val kind = (e.content as? TimelineItemContent.MsgLike)?.content?.kind ?: return@mapNotNull null
      val (body, utd) = when (kind) {
        is MsgLikeKind.Message -> ((kind.content.msgType as? MessageType.Text)?.content?.body ?: return@mapNotNull null) to false
        is MsgLikeKind.UnableToDecrypt -> null to true
        else -> return@mapNotNull null
      }
      val id = when (val x = e.eventOrTransactionId) {
        is EventOrTransactionId.EventId -> x.eventId; is EventOrTransactionId.TransactionId -> x.transactionId
      }
      val state = when (e.localSendState) {
        null, is EventSendState.Sent -> "sent"; is EventSendState.NotSentYet -> "sending"; is EventSendState.SendingFailed -> "failed"
      }
      Msg(id, e.isOwn, e.sender, body, utd, state, e.timestamp.toLong())
    }
  }

  suspend fun send(roomId: String, text: String) {
    if (text.isEmpty() || text.length > 8000) throw SendRefusedException("bad_text")
    val s = peerStatus(roomId)
    when {
      s.encrypted == false -> throw SendRefusedException("not_encrypted")
      s.encrypted != true -> throw SendRefusedException("encryption_unknown")
      s.peer == null || s.identity == "unknown" -> throw SendRefusedException("identity_unknown")
      s.identity == "changed" -> throw SendRefusedException("identity_changed")
    }
    open(roomId)
    synchronized(timelines) { timelines[roomId]!!.timeline }
      .send(messageEventContentNew(MessageType.Text(TextMessageContent(text, null))))
  }
}
