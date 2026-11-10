package app.infinitumfabric.client.domain

import android.content.SharedPreferences
import java.net.URI
import java.util.Locale

interface KeyValueStore {
    fun getBoolean(key: String, default: Boolean): Boolean
    fun putBoolean(key: String, value: Boolean)
}

class MemoryKeyValue : KeyValueStore {
    private val booleans = HashMap<String, Boolean>()

    override fun getBoolean(key: String, default: Boolean): Boolean = booleans[key] ?: default

    override fun putBoolean(key: String, value: Boolean) {
        booleans[key] = value
    }
}

class SharedPrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun getBoolean(key: String, default: Boolean): Boolean = prefs.getBoolean(key, default)

    override fun putBoolean(key: String, value: Boolean) {
        check(prefs.edit().putBoolean(key, value).commit())
    }
}

class GeoRoutingSettings(private val store: KeyValueStore) {
    fun isEnabled(): Boolean = store.getBoolean(KEY, false)

    fun setEnabled(enabled: Boolean) {
        store.putBoolean(KEY, enabled)
    }

    companion object {
        const val KEY = "geo_routing"
    }
}

private val GEO_ON = setOf("1", "true", "on", "yes")
private val GEO_OFF = setOf("0", "false", "off", "no")

fun geoFeatureEnabled(envValue: String?, geoRouting: Boolean): Boolean {
    if (envValue == null || envValue.trim().isEmpty()) return geoRouting
    val flag = envValue.trim().lowercase(Locale.ROOT)
    if (GEO_ON.contains(flag)) return true
    if (GEO_OFF.contains(flag)) return false
    return false
}

fun signInNotice(geoLabel: String?): String {
    val base = "Relay health is ok. This build does not register a device."
    if (geoLabel.isNullOrEmpty()) return base
    return "$base $geoLabel"
}

fun hostOf(url: String): String? {
    return try {
        val host = URI(url.trim()).host ?: return null
        normalizeHost(host)
    } catch (_: Exception) {
        null
    }
}

fun normalizeHost(value: String?): String? {
    if (value == null) return null
    var host = value.trim().lowercase(Locale.ROOT)
    if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length - 1)
    if (host.endsWith(".")) host = host.dropLast(1)
    if (host.isEmpty()) return null
    return host
}

class GeoHook(
    private val settings: GeoRoutingSettings,
    private val env: () -> String? = { System.getenv("INFINITUM_GEO_ENABLED") },
    private val lists: () -> GeoLists? = { null },
) {
    fun enabled(): Boolean = geoFeatureEnabled(env(), settings.isEnabled())

    fun labelForHost(host: String?): String? {
        if (!enabled()) return null
        val name = normalizeHost(host) ?: return null
        val data = try {
            lists()
        } catch (_: Exception) {
            null
        } ?: return null
        return try {
            data.labelForHost(name)
        } catch (_: Exception) {
            null
        }
    }
}
