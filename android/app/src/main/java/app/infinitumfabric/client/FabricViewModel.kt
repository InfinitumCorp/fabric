package app.infinitumfabric.client

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import app.infinitumfabric.client.data.ApiRoutes
import app.infinitumfabric.client.data.BaseUrlPolicy
import app.infinitumfabric.client.data.EconomyPreview
import app.infinitumfabric.client.data.FabricApi
import app.infinitumfabric.client.data.LedgerHead
import app.infinitumfabric.client.data.LocalChat
import app.infinitumfabric.client.data.Purpose
import app.infinitumfabric.client.data.RelayStatus
import app.infinitumfabric.client.domain.GeoHook
import app.infinitumfabric.client.domain.GeoLists
import app.infinitumfabric.client.domain.GeoRoutingSettings
import app.infinitumfabric.client.domain.MemoryKeyValue
import app.infinitumfabric.client.domain.hostOf
import app.infinitumfabric.client.domain.isValidHandle
import app.infinitumfabric.client.domain.normalizeHandle
import app.infinitumfabric.client.domain.redact
import app.infinitumfabric.client.domain.signInNotice
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
    private val geoSettings: GeoRoutingSettings = GeoRoutingSettings(MemoryKeyValue()),
    private val geoLoader: () -> GeoLists? = { null },
    private val geoEnv: () -> String? = { System.getenv("INFINITUM_GEO_ENABLED") },
) : ViewModel() {
    private val geoHook = GeoHook(geoSettings, geoEnv, geoLoader)
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
    var geoRouting by mutableStateOf(geoSettings.isEnabled())
        private set

    fun updateBaseUrl(value: String) {
        baseUrl = value
    }

    fun updateHandle(value: String) {
        handle = value
    }

    fun continueFromSignIn() {
        val typed = handle.trim()
        if (typed.isNotEmpty() && !isValidHandle(typed)) {
            error = "Handle must look like @name.veil"
            return
        }
        val typedUrl = baseUrl
        launch {
            val normalized = BaseUrlPolicy.httpsOnly.normalize(typedUrl)
            val health = withContext(Dispatchers.IO) { apiFactory(normalized).health() }
            if (!health.ok) {
                error = "Relay is not ready."
                return@launch
            }
            baseUrl = normalized
            signedIn = true
            screen = Screen.Chats
            val label = if (geoHook.enabled()) {
                withContext(Dispatchers.IO) {
                    try {
                        geoHook.labelForHost(hostOf(normalized))
                    } catch (_: Exception) {
                        null
                    }
                }
            } else {
                null
            }
            notice = signInNotice(label)
        }
    }

    fun updateGeoRouting(enabled: Boolean) {
        geoSettings.setEnabled(enabled)
        geoRouting = enabled
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

class FabricViewModelFactory(
    private val geoSettings: GeoRoutingSettings = GeoRoutingSettings(MemoryKeyValue()),
    private val geoLoader: () -> GeoLists? = { null },
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        FabricViewModel(geoSettings = geoSettings, geoLoader = geoLoader) as T
}
