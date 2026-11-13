package app.infinitumfabric.client.domain

/** Same shape as shared/crypto.js HANDLE_RE on the relay. */
private val HANDLE = Regex("^@[a-z0-9_]{2,24}\\.veil$")

fun normalizeHandle(raw: String): String = raw.trim().lowercase()

fun isValidHandle(raw: String): Boolean = HANDLE.matches(normalizeHandle(raw))
