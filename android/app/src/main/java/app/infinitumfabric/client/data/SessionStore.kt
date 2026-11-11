package app.infinitumfabric.client.data

import android.content.Context
import android.content.SharedPreferences

/** Keeps the Cumulus ID session and the in-flight PKCE values. Private to the app; backups are off. */
interface SessionStore {
    fun loadSession(): CidSession?
    fun saveSession(session: CidSession?)
    fun loadPending(): CidPending?
    fun savePending(pending: CidPending?)
}

class MemorySessionStore : SessionStore {
    private var session: CidSession? = null
    private var pending: CidPending? = null
    override fun loadSession() = session
    override fun saveSession(session: CidSession?) { this.session = session }
    override fun loadPending() = pending
    override fun savePending(pending: CidPending?) { this.pending = pending }
}

class PrefsSessionStore(context: Context) : SessionStore {
    private val prefs: SharedPreferences = context.getSharedPreferences("cumulus-id", Context.MODE_PRIVATE)

    override fun loadSession(): CidSession? {
        val token = prefs.getString("token", null) ?: return null
        return CidSession(
            token = token,
            expiresAtMillis = prefs.getLong("until", 0L),
            profile = CidProfile(
                cid = prefs.getString("cid", "").orEmpty(),
                username = prefs.getString("username", "").orEmpty(),
                email = prefs.getString("email", "").orEmpty(),
                handle = prefs.getString("handle", "").orEmpty(),
            ),
        )
    }

    override fun saveSession(session: CidSession?) {
        prefs.edit().apply {
            if (session == null) {
                listOf("token", "until", "cid", "username", "email", "handle").forEach(::remove)
            } else {
                putString("token", session.token)
                putLong("until", session.expiresAtMillis)
                putString("cid", session.profile.cid)
                putString("username", session.profile.username)
                putString("email", session.profile.email)
                putString("handle", session.profile.handle)
            }
        }.apply()
    }

    override fun loadPending(): CidPending? {
        val verifier = prefs.getString("p_verifier", null) ?: return null
        val state = prefs.getString("p_state", null) ?: return null
        val issuer = prefs.getString("p_issuer", null) ?: return null
        return CidPending(verifier, state, issuer)
    }

    override fun savePending(pending: CidPending?) {
        prefs.edit().apply {
            if (pending == null) {
                listOf("p_verifier", "p_state", "p_issuer").forEach(::remove)
            } else {
                putString("p_verifier", pending.verifier)
                putString("p_state", pending.state)
                putString("p_issuer", pending.issuer)
            }
        }.apply()
    }
}
