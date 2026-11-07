package expo.modules.fabricmatrix

import org.matrix.rustcomponents.sdk.*
import uniffi.matrix_sdk_base.EncryptionState
import java.util.Collections

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
  private var sync: SyncService? = null
  private val timelines = HashMap<String, Pair<Timeline, MutableList<TimelineItem>>>()
  private val handles = ArrayList<TaskHandle>()

  suspend fun start() { if (sync == null) sync = client.syncService().finish().also { it.start() } }

  suspend fun stop() {
    handles.forEach { it.cancel() }; handles.clear(); timelines.clear()
    sync?.stop(); sync = null
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
    if (timelines.containsKey(roomId)) return
    val t = room(roomId).timeline()
    val items: MutableList<TimelineItem> = Collections.synchronizedList(ArrayList())
    handles += t.addListener(object : TimelineListener {
      override fun onUpdate(diff: List<TimelineDiff>) = synchronized(items) {
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
          is TimelineDiff.Clear -> items.clear()
          is TimelineDiff.Reset -> { items.clear(); items.addAll(d.values) }
        }
      }
    })
    timelines[roomId] = t to items
    try { t.paginateBackwards(30u) } catch (_: Exception) {}
  }

  fun messages(roomId: String): List<Msg> {
    val items = timelines[roomId]?.second ?: return emptyList()
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
    timelines[roomId]!!.first.send(messageEventContentNew(MessageType.Text(TextMessageContent(text, null))))
  }
}
