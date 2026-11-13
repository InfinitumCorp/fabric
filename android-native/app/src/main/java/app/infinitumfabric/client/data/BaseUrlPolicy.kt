package app.infinitumfabric.client.data

import java.net.URI

fun interface BaseUrlPolicy {
    fun normalize(raw: String): String

    companion object {
        val httpsOnly: BaseUrlPolicy = BaseUrlPolicy { raw ->
            val trimmed = raw.trim().trimEnd('/')
            val parsed = try {
                URI(trimmed)
            } catch (_: Exception) {
                throw IllegalArgumentException("https_required")
            }
            if (parsed.scheme?.lowercase() != "https" || parsed.host.isNullOrBlank()) {
                throw IllegalArgumentException("https_required")
            }
            if (!parsed.userInfo.isNullOrBlank() || parsed.rawQuery != null || parsed.rawFragment != null) {
                throw IllegalArgumentException("https_required")
            }
            trimmed
        }
    }
}
