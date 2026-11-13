package expo.modules.fabricmatrix

import org.json.JSONObject
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientBuilder
import org.matrix.rustcomponents.sdk.Session
import org.matrix.rustcomponents.sdk.SlidingSyncVersion
import org.matrix.rustcomponents.sdk.SlidingSyncVersionBuilder
import org.matrix.rustcomponents.sdk.SqliteStoreBuilder
import java.io.File

data class SessionIds(val userId: String, val deviceId: String)

/**
 * Wraps the Matrix Rust SDK client for one account on this device.
 * The SQLite stores (crypto, state, event cache) are opened with the Keystore-protected key.
 * Access tokens, passwords and keys never leave this class except into the SDK.
 */
class MatrixEngine(private val root: File, alias: String = "fabric_store_wrap") {
  private val vault = KeyVault(File(root, "vault"), alias)
  private val data = File(root, "matrix/data")
  private val cache = File(root, "matrix/cache")
  var client: Client? = null
    private set
  var messenger: Messenger? = null
    private set

  private suspend fun build(homeserver: String, key: ByteArray): Client {
    data.mkdirs(); cache.mkdirs()
    return ClientBuilder()
      .homeserverUrl(homeserver)
      .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.NATIVE)
      // Creates this account's cross-signing identity so peers can resolve it (sends refuse unresolved identities).
      .autoEnableCrossSigning(true)
      .sqliteStore(SqliteStoreBuilder(data.path, cache.path).key(key))
      .build()
  }

  /** Returns null if never signed in. Throws StoreLockedException if a store exists but its key is unusable. */
  suspend fun restore(homeserver: String): SessionIds? {
    if (!vault.hasKey()) {
      if (data.exists() && (data.list()?.isNotEmpty() == true)) throw StoreLockedException("store without key")
      return null
    }
    val key = vault.loadStoreKey()
    val s = vault.loadSession() ?: return null
    val j = JSONObject(String(s))
    val c = build(homeserver, key)
    c.restoreSession(
      Session(
        accessToken = j.getString("a"), refreshToken = null, userId = j.getString("u"),
        deviceId = j.getString("d"), homeserverUrl = j.getString("h"), oauthData = null,
        slidingSyncVersion = SlidingSyncVersion.NATIVE,
      )
    )
    client = c; messenger = Messenger(c)
    return SessionIds(c.userId(), c.deviceId())
  }

  suspend fun login(homeserver: String, username: String, password: String): SessionIds {
    if (vault.hasKey() || (data.list()?.isNotEmpty() == true)) throw IllegalStateException("already_signed_in")
    val key = vault.createStoreKey()
    val c = build(homeserver, key)
    try {
      c.login(username, password, "FabriC++ Android", null)
    } catch (e: Exception) {
      wipeLocal(); throw e
    }
    val s = c.session()
    vault.saveSession(
      JSONObject().put("a", s.accessToken).put("u", s.userId).put("d", s.deviceId).put("h", s.homeserverUrl)
        .toString().toByteArray()
    )
    client = c; messenger = Messenger(c)
    return SessionIds(s.userId, s.deviceId)
  }

  /** Server logout best effort, then always deletes local stores, session and keys. */
  suspend fun logoutAndWipe() {
    try { messenger?.stop() } catch (_: Exception) {}
    messenger = null
    try { client?.logout() } catch (_: Exception) {}
    client?.destroy(); client = null
    wipeLocal()
  }

  private fun wipeLocal() {
    client = null; messenger = null
    File(root, "matrix").deleteRecursively()
    vault.wipe()
  }
}
