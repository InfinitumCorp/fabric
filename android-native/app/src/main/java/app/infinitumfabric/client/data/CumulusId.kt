package app.infinitumfabric.client.data

import app.infinitumfabric.client.domain.redact
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * "Sign in with Cumulus://ID": OpenID Connect authorization code + PKCE S256 + state + nonce against
 * the issuer https://id.cumuluscloud.app/realms/cumulus (public client "fabric", no secret).
 *
 *   1. A Custom Tab opens {host}/realms/cumulus/protocol/openid-connect/auth. People without a
 *      Cumulus ID create one there (prompt=create opens that page first), then the IdP continues.
 *   2. The IdP redirects to https://infinitumfabric.app/cid/return?code&state. That URL is an
 *      Android App Link for this app; if the browser keeps it, the page hands off to
 *      infinitumfabric://cid/return?code&state.
 *   3. The app posts the code and verifier (form) to …/protocol/openid-connect/token, then verifies
 *      the ID token ([IdTokenVerifier]: ES256 against …/certs, iss, aud, exp, nonce) before it keeps
 *      the session, keyed by the token's sub.
 *   4. Sign-out revokes the access token at …/protocol/openid-connect/revoke.
 *
 * The host is a build setting (CID_ISSUER) and falls back to the Russia mirror when the main host
 * does not answer. The mirror serves the same realm: endpoints and keys come from whichever host
 * answered, but the ID token's iss is always [CidConfig.OIDC_ISSUER].
 */
data class CidConfig(
    val issuer: String,
    val clientId: String,
    val redirectUri: String,
    /** Tried in order when [issuer] does not answer (e.g. Cloudflare stalls on some Russian networks). */
    val fallbackIssuers: List<String> = listOf(RU_ISSUER),
) {
    init {
        require(issuer.startsWith("https://")) { "Cumulus ID issuer must be HTTPS" }
        require(fallbackIssuers.all { it.startsWith("https://") }) { "Cumulus ID fallback issuers must be HTTPS" }
        require(redirectUri.startsWith("https://")) { "Cumulus ID redirect must be HTTPS" }
    }

    companion object {
        const val DEFAULT_ISSUER = "https://id.cumuluscloud.app"
        /** The `iss` of every Cumulus://ID token, whichever host served it. */
        const val OIDC_ISSUER = "https://id.cumuluscloud.app/realms/cumulus"
        const val REALM_PATH = "/realms/cumulus"
        const val SCOPE = "openid profile email"
        /** Same Cumulus ID, served from a host that is reachable in Russia without a VPN. */
        const val RU_ISSUER = "https://ru.id.cumuluscloud.app"
        const val DEFAULT_CLIENT = "fabric"
        const val DEFAULT_REDIRECT = "https://infinitumfabric.app/cid/return"
        const val APP_SCHEME = "infinitumfabric"
        /** The Cumulus ID sign-in page's main script (about 75 KB), used to test a host end to end. */
        const val SIGN_IN_SCRIPT = "/app.js"
        const val MIN_SCRIPT_BYTES = 32 * 1024

        /** The host part of an issuer setting (a full realm URL is accepted too). */
        fun hostOf(issuer: String): String = issuer.trimEnd('/').removeSuffix(REALM_PATH)

        /** The realm's OpenID Connect endpoints on [issuer]'s host (main or mirror). */
        fun oidc(issuer: String): String = hostOf(issuer) + REALM_PATH + "/protocol/openid-connect"
    }
}

/** What the app keeps between the Custom Tab opening and the return. */
data class CidPending(val verifier: String, val state: String, val issuer: String, val nonce: String)

data class CidProfile(
    /** The verified ID token's `sub`: the stable account id the session is keyed by. */
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
    /** Checks ID tokens; keeps the JWKS between sign-ins. Tests inject one with a fixed clock. */
    private val verifier: IdTokenVerifier = IdTokenVerifier(config.clientId, { url -> fetchJwks(http, url) }),
) {
    /** The issuer sign-in uses: [CidConfig.issuer], or the first fallback that answered when it did not. */
    @Volatile
    var activeIssuer: String = config.issuer
        private set

    /**
     * Picks an issuer that can actually serve the sign-in page on this network (blocking; call off the
     * main thread). Some Russian networks let Cloudflare answer small requests but stall every transfer
     * after the first few kilobytes, so a host only counts when it delivers the full sign-in script.
     * When no host passes, any host that answers at all is used, then [CidConfig.issuer].
     */
    fun pickReachableIssuer(
        probe: (String) -> Boolean = ::servesSignIn,
        answersAtAll: (String) -> Boolean = ::answers,
        throttledNetwork: Boolean = false,
    ): String {
        // Russian and Belarusian networks throttle Cloudflare on and off, so a probe can pass and the
        // page still stall. There the mirrors go first (same approach as the +SPCTR app).
        val all = if (throttledNetwork) config.fallbackIssuers + config.issuer else listOf(config.issuer) + config.fallbackIssuers
        val chosen = all.firstOrNull(probe) ?: all.firstOrNull(answersAtAll) ?: config.issuer
        activeIssuer = chosen
        return chosen
    }

    private fun quickClient(seconds: Long) = http.newBuilder()
        .connectTimeout(4, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(4, java.util.concurrent.TimeUnit.SECONDS)
        .callTimeout(seconds, java.util.concurrent.TimeUnit.SECONDS)
        .followRedirects(false)
        .build()

    /** True when the issuer delivers its whole sign-in script (tens of kilobytes) within a few seconds. */
    private fun servesSignIn(issuer: String): Boolean = try {
        val request = Request.Builder().url(CidConfig.hostOf(issuer) + CidConfig.SIGN_IN_SCRIPT)
            .header("User-Agent", "FabricAndroid/0.1.0").build()
        quickClient(8).newCall(request).execute().use { response ->
            response.isSuccessful && (response.body?.bytes()?.size ?: 0) >= CidConfig.MIN_SCRIPT_BYTES
        }
    } catch (_: Exception) {
        false
    }

    private fun answers(issuer: String): Boolean = try {
        val request = Request.Builder().url(CidConfig.hostOf(issuer) + "/").head()
            .header("User-Agent", "FabricAndroid/0.1.0").build()
        quickClient(6).newCall(request).execute().use { it.code in 200..499 }
    } catch (_: Exception) {
        false
    }

    fun newPending(): CidPending =
        CidPending(verifier = randomToken(48), state = randomToken(16), issuer = activeIssuer, nonce = randomToken(16))

    /** The authorize URL to open in a Custom Tab. [create] asks the IdP to show "Create a Cumulus ID" first. */
    fun authorizeUrl(pending: CidPending, create: Boolean = false): String {
        val params = buildList {
            add("client_id" to config.clientId)
            add("redirect_uri" to config.redirectUri)
            add("response_type" to "code")
            add("scope" to CidConfig.SCOPE)
            add("code_challenge" to challenge(pending.verifier))
            add("code_challenge_method" to "S256")
            add("state" to pending.state)
            add("nonce" to pending.nonce)
            if (create) add("prompt" to "create")
        }
        return CidConfig.oidc(pending.issuer) + "/auth?" + params.joinToString("&") { (k, v) -> "$k=${enc(v)}" }
    }

    /**
     * Trades a returned code for tokens on the host that served the sign-in, then verifies the ID
     * token before returning a session keyed by its sub. Throws [ApiException] (token endpoint) or
     * [IdTokenException] (verification) with a short reason that never contains a token.
     */
    fun redeem(pending: CidPending, code: String): CidSession {
        val body = FormBody.Builder()
            .add("grant_type", "authorization_code")
            .add("code", code)
            .add("code_verifier", pending.verifier)
            .add("client_id", config.clientId)
            .add("redirect_uri", config.redirectUri)
            .build()
        val request = Request.Builder()
            .url(CidConfig.oidc(pending.issuer) + "/token")
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
            val verified = try {
                verifier.verify(json.optString("id_token").ifBlank { null }, pending.nonce, CidConfig.oidc(pending.issuer) + "/certs")
            } catch (e: IdTokenException) {
                throw IdTokenException("That sign-in couldn't be verified (${e.message}). Please try again.")
            }
            val expiresIn = json.optLong("expires_in", 3600L).coerceIn(60L, 60L * 60 * 24 * 30)
            return CidSession(
                token = token,
                expiresAtMillis = System.currentTimeMillis() + expiresIn * 1000,
                profile = profileOf(verified),
            )
        }
    }

    /**
     * Revokes the access token at Cumulus://ID (RFC 7009) so this app session leaves the person's
     * session list, on the host that currently answers. Best effort; the local copy is already gone.
     */
    fun signOut(token: String, issuer: String = activeIssuer) {
        val body = FormBody.Builder()
            .add("token", token)
            .add("token_type_hint", "access_token")
            .add("client_id", config.clientId)
            .build()
        val request = Request.Builder()
            .url(CidConfig.oidc(issuer) + "/revoke")
            .header("User-Agent", "FabricAndroid/0.1.0")
            .post(body)
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

        /** The person from a verified ID token, keyed by its `sub`. */
        fun profileOf(token: VerifiedIdToken) = CidProfile(
            cid = token.sub,
            username = token.claims.optString("preferred_username").ifBlank { token.claims.optString("username") },
            email = token.claims.optString("email"),
            handle = token.claims.optString("handle"),
        )

        /** GETs a JWKS document (no redirects: keys come only from the host that answered). */
        fun fetchJwks(http: OkHttpClient, url: String): String {
            val request = Request.Builder().url(url)
                .header("Accept", "application/json")
                .header("User-Agent", "FabricAndroid/0.1.0")
                .build()
            http.newBuilder().followRedirects(false).build().newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw java.io.IOException("JWKS answered ${response.code}")
                return response.body?.string().orEmpty()
            }
        }

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
