package app.infinitumfabric.client.data

import app.infinitumfabric.client.domain.redact
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * "Sign in with Cumulus ID" (OAuth 2.0 authorization code + PKCE S256).
 *
 *   1. A Custom Tab opens {issuer}/api/id/authorize. People without a Cumulus ID create one there
 *      (prompt=create opens that page first), then the IdP continues the same request.
 *   2. The IdP redirects to https://infinitumfabric.app/cid/return?code&state. That URL is an
 *      Android App Link for this app; if the browser keeps it, the page hands off to
 *      infinitumfabric://cid/return?code&state.
 *   3. The app posts the code and verifier to {issuer}/api/id/token and keeps the access token.
 *
 * The issuer is a build setting (CID_ISSUER) so a Russia-reachable mirror can be dropped in.
 */
data class CidConfig(
    val issuer: String,
    val clientId: String,
    val redirectUri: String,
) {
    init {
        require(issuer.startsWith("https://")) { "Cumulus ID issuer must be HTTPS" }
        require(redirectUri.startsWith("https://")) { "Cumulus ID redirect must be HTTPS" }
    }

    companion object {
        const val DEFAULT_ISSUER = "https://id.cumuluscloud.app"
        const val DEFAULT_CLIENT = "fabric"
        const val DEFAULT_REDIRECT = "https://infinitumfabric.app/cid/return"
        const val APP_SCHEME = "infinitumfabric"
    }
}

/** What the app keeps between the Custom Tab opening and the return. */
data class CidPending(val verifier: String, val state: String, val issuer: String)

data class CidProfile(
    val cid: String,
    val username: String,
    val email: String,
    val handle: String,
) {
    val display: String get() = email.ifBlank { username.ifBlank { handle.ifBlank { "Signed in" } } }
}

data class CidSession(
    val token: String,
    val expiresAtMillis: Long,
    val profile: CidProfile,
) {
    fun isLive(nowMillis: Long = System.currentTimeMillis()): Boolean = token.isNotBlank() && nowMillis < expiresAtMillis
}

class CumulusId(
    val config: CidConfig,
    private val http: OkHttpClient = FabricApi.defaultClient(),
    private val random: SecureRandom = SecureRandom(),
) {
    fun newPending(): CidPending = CidPending(verifier = randomToken(48), state = randomToken(16), issuer = config.issuer)

    /** The authorize URL to open in a Custom Tab. [create] asks the IdP to show "Create a Cumulus ID" first. */
    fun authorizeUrl(pending: CidPending, create: Boolean = false): String {
        val params = buildList {
            add("client_id" to config.clientId)
            add("redirect_uri" to config.redirectUri)
            add("response_type" to "code")
            add("code_challenge" to challenge(pending.verifier))
            add("code_challenge_method" to "S256")
            add("state" to pending.state)
            if (create) add("prompt" to "create")
        }
        return pending.issuer.trimEnd('/') + "/api/id/authorize?" + params.joinToString("&") { (k, v) -> "$k=${enc(v)}" }
    }

    /** Trades a returned code for a session. Throws [ApiException] with a short, redacted reason. */
    fun redeem(pending: CidPending, code: String): CidSession {
        val body = JSONObject()
            .put("code", code)
            .put("code_verifier", pending.verifier)
            .put("client_id", config.clientId)
            .put("redirect_uri", config.redirectUri)
            .toString()
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url(pending.issuer.trimEnd('/') + "/api/id/token")
            .header("Accept", "application/json")
            .header("User-Agent", "FabricAndroid/0.1.0")
            .post(body)
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = try {
                if (text.isBlank()) JSONObject() else JSONObject(text)
            } catch (_: Exception) {
                JSONObject()
            }
            if (!response.isSuccessful) {
                val reason = redact(json.optString("error").ifBlank { "http_${response.code}" }).take(120)
                throw ApiException(response.code, reason)
            }
            val token = json.optString("access_token")
            if (token.isBlank()) throw ApiException(response.code, "no_token")
            val expiresIn = json.optLong("expires_in", 3600L).coerceIn(60L, 60L * 60 * 24 * 30)
            return CidSession(
                token = token,
                expiresAtMillis = System.currentTimeMillis() + expiresIn * 1000,
                profile = parseProfile(json.optJSONObject("profile") ?: JSONObject()),
            )
        }
    }

    /** Ends the Cumulus ID session for this app. Best effort; the local copy is already gone. */
    fun signOut(token: String) {
        val request = Request.Builder()
            .url(config.issuer.trimEnd('/') + "/api/id/signout")
            .header("Authorization", "Bearer $token")
            .header("User-Agent", "FabricAndroid/0.1.0")
            .post("{}".toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(request).execute().close()
    }

    private fun randomToken(bytes: Int): String {
        val buf = ByteArray(bytes)
        random.nextBytes(buf)
        return b64url(buf)
    }

    companion object {
        fun challenge(verifier: String): String =
            b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

        fun parseProfile(json: JSONObject) = CidProfile(
            cid = json.optString("cid"),
            username = json.optString("username"),
            email = json.optString("email"),
            handle = json.optString("handle"),
        )

        /**
         * Reads code/state (or error) from a return URI: the App Link
         * https://infinitumfabric.app/cid/return?... or infinitumfabric://cid/return?...
         * Returns null for any other URI.
         */
        fun parseReturn(uri: String, config: CidConfig): CidReturn? {
            val parsed = try {
                URI(uri)
            } catch (_: Exception) {
                return null
            }
            val redirect = URI(config.redirectUri)
            val isAppLink = parsed.scheme == "https" && parsed.host == redirect.host && parsed.path == redirect.path
            val isScheme = parsed.scheme == CidConfig.APP_SCHEME && parsed.host == "cid" && parsed.path == "/return"
            if (!isAppLink && !isScheme) return null
            val query = (parsed.rawQuery ?: "").split("&").filter { it.isNotEmpty() }.associate {
                val i = it.indexOf('=')
                if (i < 0) dec(it) to "" else dec(it.substring(0, i)) to dec(it.substring(i + 1))
            }
            return CidReturn(code = query["code"].orEmpty(), state = query["state"].orEmpty(), error = query["error"].orEmpty())
        }

        private fun b64url(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        private fun enc(v: String) = URLEncoder.encode(v, "UTF-8")
        private fun dec(v: String) = java.net.URLDecoder.decode(v, "UTF-8")
    }
}

data class CidReturn(val code: String, val state: String, val error: String)
