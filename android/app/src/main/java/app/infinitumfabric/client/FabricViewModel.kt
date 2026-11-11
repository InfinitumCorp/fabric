package app.infinitumfabric.client

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import app.infinitumfabric.client.data.ApiRoutes
import app.infinitumfabric.client.data.BaseUrlPolicy
import app.infinitumfabric.client.data.CidProfile
import app.infinitumfabric.client.data.CumulusId
import app.infinitumfabric.client.data.EconomyPreview
import app.infinitumfabric.client.data.FabricApi
import app.infinitumfabric.client.data.LedgerHead
import app.infinitumfabric.client.data.LocalChat
import app.infinitumfabric.client.data.Purpose
import app.infinitumfabric.client.data.MemorySessionStore
import app.infinitumfabric.client.data.RelayStatus
import app.infinitumfabric.client.data.SessionStore
import app.infinitumfabric.client.domain.isValidHandle
import app.infinitumfabric.client.domain.normalizeHandle
import app.infinitumfabric.client.domain.redact
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface Screen {
    data object SignIn : Screen
    data object Chats : Screen
    data class Conversation(val handle: String) : Screen
    data object NewChat : Screen
    data class Contact(val handle: String) : Screen
    data object Settings : Screen
    data object Plan : Screen
    data object Data : Screen
}

class FabricViewModel(
    private val apiFactory: (String) -> FabricApi = { FabricApi(baseUrl = it) },
    private val cid: CumulusId = CumulusId(cidConfig()),
    private val store: SessionStore = MemorySessionStore(),
) : ViewModel() {
    var screen by mutableStateOf<Screen>(Screen.SignIn)
        private set
    var baseUrl by mutableStateOf(ApiRoutes.DEFAULT_BASE_URL)
        private set
    var handle by mutableStateOf("")
        private set
    var signedIn by mutableStateOf(false)
        private set
    var chats by mutableStateOf<List<LocalChat>>(emptyList())
        private set
    var purposes by mutableStateOf<List<Purpose>>(emptyList())
        private set
    var preview by mutableStateOf<EconomyPreview?>(null)
        private set
    var ledger by mutableStateOf<LedgerHead?>(null)
        private set
    var relay by mutableStateOf<RelayStatus?>(null)
        private set
    var consent by mutableStateOf<Map<String, Boolean>>(emptyMap())
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
        private set
    var profile by mutableStateOf<CidProfile?>(null)
        private set
    var showAdvanced by mutableStateOf(false)
        private set

    init {
        val saved = store.loadSession()
        if (saved != null && saved.isLive()) {
            profile = saved.profile
            signedIn = true
            screen = Screen.Chats
        } else if (saved != null) {
            store.saveSession(null)
        }
    }

    val cidIssuer: String get() = cid.activeIssuer

    /** Picks a Cumulus ID host that works on this network before the person taps "Sign in". */
    fun chooseCidIssuer(throttledNetwork: Boolean) {
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { cid.pickReachableIssuer(throttledNetwork = throttledNetwork) }
        }
    }

    /**
     * Starts "Sign in with Cumulus ID". Returns the authorize URL for the Custom Tab.
     * [create] opens the IdP's "Create a Cumulus ID" page first; it returns here signed in either way.
     */
    fun beginCidSignIn(create: Boolean = false): String {
        error = null
        notice = null
        val pending = cid.newPending()
        store.savePending(pending)
        return cid.authorizeUrl(pending, create)
    }

    /** Handles the return from Cumulus ID. Returns false when [uri] is not a Cumulus ID return. */
    fun handleCidReturn(uri: String): Boolean {
        val back = CumulusId.parseReturn(uri, cid.config) ?: return false
        val pending = store.loadPending()
        store.savePending(null)
        if (back.error.isNotEmpty()) {
            error = "Cumulus ID sign-in was not completed."
            return true
        }
        if (pending == null || back.state.isEmpty() || back.state != pending.state || back.code.isEmpty()) {
            error = "That sign-in didn't match. Please try again."
            return true
        }
        launch {
            val session = withContext(Dispatchers.IO) { cid.redeem(pending, back.code) }
            store.saveSession(session)
            profile = session.profile
            signedIn = true
            screen = Screen.Chats
            notice = "Signed in with Cumulus ID as ${session.profile.display}."
        }
        return true
    }

    fun reportNoBrowser() {
        error = "No browser is installed to open Cumulus ID."
    }

    fun toggleAdvanced() {
        showAdvanced = !showAdvanced
    }

    fun updateBaseUrl(value: String) {
        baseUrl = value
    }

    fun updateHandle(value: String) {
        handle = value
    }

    /** Advanced setting: checks a different relay's health and uses it. Not part of signing in. */
    fun checkRelay() {
        val typedUrl = baseUrl
        launch {
            val normalized = BaseUrlPolicy.httpsOnly.normalize(typedUrl)
            val health = withContext(Dispatchers.IO) { apiFactory(normalized).health() }
            if (!health.ok) {
                error = "Relay is not ready."
                return@launch
            }
            baseUrl = normalized
            notice = "Relay health is ok. This build does not register a device."
        }
    }

    fun open(next: Screen) {
        error = null
        screen = next
        when (next) {
            Screen.Plan -> loadPlan()
            Screen.Data -> loadData()
            Screen.Settings -> loadSettings()
            else -> Unit
        }
    }

    fun back() {
        screen = if (screen is Screen.SignIn || screen is Screen.Chats) screen else Screen.Chats
        error = null
    }

    fun addChat(raw: String) {
        val name = normalizeHandle(raw)
        if (!isValidHandle(name)) {
            error = "Handle must look like @name.veil"
            return
        }
        if (chats.none { it.handle == name }) chats = chats + LocalChat(name)
        screen = Screen.Conversation(name)
        error = null
    }

    fun toggleConsent(key: String, on: Boolean) {
        consent = consent + (key to on)
        notice = "Kept on this device. A registered socket is required before the relay records consent."
    }

    fun signOut() {
        val session = store.loadSession()
        store.saveSession(null)
        store.savePending(null)
        if (session != null) {
            viewModelScope.launch(Dispatchers.IO) { runCatching { cid.signOut(session.token) } }
        }
        profile = null
        signedIn = false
        chats = emptyList()
        purposes = emptyList()
        preview = null
        ledger = null
        relay = null
        consent = emptyMap()
        notice = null
        error = null
        screen = Screen.SignIn
    }

    private fun loadPlan() {
        val url = baseUrl
        launch {
            preview = withContext(Dispatchers.IO) { apiFactory(url).preview() }
        }
    }

    private fun loadData() {
        val url = baseUrl
        launch {
            val loaded = withContext(Dispatchers.IO) { apiFactory(url).purposes() }
            purposes = loaded
            if (consent.isEmpty()) consent = loaded.associate { it.key to false }
        }
    }

    private fun loadSettings() {
        val url = baseUrl
        launch {
            val api = apiFactory(url)
            val head = withContext(Dispatchers.IO) { api.ledger() }
            val status = withContext(Dispatchers.IO) { api.status() }
            ledger = head
            relay = status
        }
    }

    private fun launch(block: suspend () -> Unit) {
        viewModelScope.launch {
            busy = true
            error = null
            try {
                block()
            } catch (thrown: Throwable) {
                error = redact(thrown.message ?: thrown.javaClass.simpleName)
            } finally {
                busy = false
            }
        }
    }
}

fun cidConfig() = app.infinitumfabric.client.data.CidConfig(
    issuer = BuildConfig.CID_ISSUER,
    clientId = BuildConfig.CID_CLIENT,
    redirectUri = BuildConfig.CID_REDIRECT,
)

class FabricViewModelFactory(private val store: SessionStore) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = FabricViewModel(store = store) as T
}
