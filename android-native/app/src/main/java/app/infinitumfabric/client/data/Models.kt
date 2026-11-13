package app.infinitumfabric.client.data

data class Health(val ok: Boolean)

data class Purpose(
    val key: String,
    val label: String,
    val detail: String,
    val weight: Double,
)

data class EconomyPreview(
    val revenueCents: Int,
    val poolCents: Int,
    val infinitumCents: Int,
    val participants: Int,
    val fabPerUsd: Int,
)

data class LedgerHead(
    val valid: Boolean,
    val length: Int,
    val head: String,
)

data class RelayStatus(
    val cidEnabled: Boolean,
    val cidRequired: Boolean,
    val sfu: Boolean,
    val turn: Boolean,
    val iceServerCount: Int,
    val modelsAvailable: Boolean,
)

data class LocalChat(val handle: String)

class ApiException(val status: Int, val code: String) : Exception("HTTP $status $code")
