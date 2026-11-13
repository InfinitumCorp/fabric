package app.infinitumfabric.client.data

/**
 * HTTP routes from the FabriC++ relay (server/relay.js on feat/relay-pq).
 *
 * PR #46 was not readable with this repository's credentials (no pull request 46
 * in InfinitumCorp/fabric, and InfinitumCorp/infinitum-nexus returns 404). These
 * are the routes that server actually exposes for a client without an operator token.
 * The client never calls POST /api/economy/settle.
 */
object ApiRoutes {
    const val DEFAULT_BASE_URL = "https://infinitumfabric.app"
    const val HEALTH = "/api/health"
    const val PURPOSES = "/api/purposes"
    const val PREVIEW = "/api/economy/preview?revenue=0"
    const val LEDGER = "/api/ledger"
    const val CID = "/api/cid"
    const val ICE = "/api/ice"
    const val MODELS = "/api/models"
    const val SETTLE = "/api/economy/settle"
}

/** Primary ABI for the TECNO Android 15 phone. The debug APK also ships the other ABIs. */
object SupportedDevices {
    const val PRIMARY_ABI = "arm64-v8a"
    const val TARGET_SDK = 35
}
