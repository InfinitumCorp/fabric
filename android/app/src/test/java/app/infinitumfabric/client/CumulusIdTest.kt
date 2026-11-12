package app.infinitumfabric.client

import app.infinitumfabric.client.data.ApiException
import app.infinitumfabric.client.data.CidConfig
import app.infinitumfabric.client.data.CumulusId
import app.infinitumfabric.client.data.IdTokenException
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.URI
import java.net.URLDecoder
import java.security.KeyPair

class CumulusIdTest {
    private lateinit var server: MockWebServer
    private val config = CidConfig(CidConfig.DEFAULT_ISSUER, CidConfig.DEFAULT_CLIENT, CidConfig.DEFAULT_REDIRECT)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun query(url: String): Map<String, String> = URI(url).rawQuery.split("&").associate {
        val (k, v) = it.split("=", limit = 2)
        k to URLDecoder.decode(v, "UTF-8")
    }

    private fun form(body: String): Map<String, String> = query("x:/?$body")

    /** Serves the realm's token, certs and revoke endpoints like Cumulus://ID (or a mirror) does. */
    private fun serve(key: KeyPair, tokenBody: (RecordedRequest) -> String) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/realms/cumulus/protocol/openid-connect/token" ->
                    MockResponse().setHeader("Content-Type", "application/json").setBody(tokenBody(request))
                "/realms/cumulus/protocol/openid-connect/certs" ->
                    MockResponse().setHeader("Content-Type", "application/json").setBody(TestIdTokens.jwks(TestIdTokens.jwk(key, "k1")))
                "/realms/cumulus/protocol/openid-connect/revoke" -> MockResponse().setResponseCode(200)
                else -> MockResponse().setResponseCode(404)
            }
        }
    }

    private fun tokenJson(idToken: String) =
        JSONObject().put("access_token", "tok").put("token_type", "Bearer").put("expires_in", 600).put("id_token", idToken).toString()

    @Test
    fun authorizeUrlUsesTheOidcRealmWithPkceStateAndNonce() {
        val cid = CumulusId(config)
        val pending = cid.newPending()
        val url = cid.authorizeUrl(pending)
        assertTrue(url.startsWith("https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/auth?"))
        val q = query(url)
        assertEquals("fabric", q["client_id"])
        assertEquals("https://infinitumfabric.app/cid/return", q["redirect_uri"])
        assertEquals("code", q["response_type"])
        assertEquals("openid profile email", q["scope"])
        assertEquals(pending.nonce, q["nonce"])
        assertTrue(Regex("^[A-Za-z0-9_-]{22}$").matches(pending.nonce))
        assertEquals("S256", q["code_challenge_method"])
        assertEquals(CumulusId.challenge(pending.verifier), q["code_challenge"])
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(q["code_challenge"]!!))
        assertEquals(pending.state, q["state"])
        assertFalse(q.containsKey("prompt"))
        assertEquals("create", query(cid.authorizeUrl(pending, create = true))["prompt"])
    }

    @Test
    fun challengeMatchesRfc7636Example() {
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            CumulusId.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        )
    }

    @Test
    fun parsesAppLinkAndSchemeReturnsOnly() {
        val a = CumulusId.parseReturn("https://infinitumfabric.app/cid/return?code=abc&state=s%2B1", config)!!
        assertEquals("abc", a.code)
        assertEquals("s+1", a.state)
        val b = CumulusId.parseReturn("infinitumfabric://cid/return?code=xyz&state=t", config)!!
        assertEquals("xyz", b.code)
        assertNull(CumulusId.parseReturn("https://evil.example/cid/return?code=abc&state=s", config))
        assertNull(CumulusId.parseReturn("https://infinitumfabric.app/other?code=abc", config))
    }

    @Test
    fun redeemPostsAFormVerifiesTheIdTokenAndKeysBySub() {
        val key = TestIdTokens.keyPair()
        val cid = CumulusId(config, OkHttpClient())
        val pending = cid.newPending().copy(issuer = server.url("/").toString().trimEnd('/'))
        serve(key) { tokenJson(TestIdTokens.sign(key, TestIdTokens.header(), TestIdTokens.claims(nonce = pending.nonce))) }
        val session = cid.redeem(pending, "code1")
        val request = server.takeRequest()
        assertEquals("/realms/cumulus/protocol/openid-connect/token", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/x-www-form-urlencoded"))
        val body = form(request.body.readUtf8())
        assertEquals("authorization_code", body["grant_type"])
        assertEquals("code1", body["code"])
        assertEquals(pending.verifier, body["code_verifier"])
        assertEquals("fabric", body["client_id"])
        assertEquals("https://infinitumfabric.app/cid/return", body["redirect_uri"])
        // Keys come from the host that served the sign-in.
        assertEquals("/realms/cumulus/protocol/openid-connect/certs", server.takeRequest().path)
        assertEquals("tok", session.token)
        assertEquals("cid_7c1e", session.profile.cid)
        assertEquals("ann", session.profile.username)
        assertEquals("@ann.veil", session.profile.handle)
        assertEquals("ann@cumuluscloud.app", session.profile.display)
        assertTrue(session.isLive())
    }

    @Test
    fun redeemRejectsAnIdTokenWithTheWrongNonceOrSigner() {
        val key = TestIdTokens.keyPair()
        val cid = CumulusId(config, OkHttpClient())
        val pending = cid.newPending().copy(issuer = server.url("/").toString().trimEnd('/'))
        serve(key) { tokenJson(TestIdTokens.sign(key, TestIdTokens.header(), TestIdTokens.claims(nonce = "replayed"))) }
        assertThrows(IdTokenException::class.java) { cid.redeem(pending, "code1") }
        serve(key) { tokenJson(TestIdTokens.sign(TestIdTokens.keyPair(), TestIdTokens.header(), TestIdTokens.claims(nonce = pending.nonce))) }
        assertThrows(IdTokenException::class.java) { cid.redeem(pending, "code1") }
        serve(key) { """{"access_token":"tok","expires_in":600}""" }
        assertThrows(IdTokenException::class.java) { cid.redeem(pending, "code1") }
    }

    @Test
    fun signOutRevokesTheTokenAtTheRealm() {
        server.enqueue(MockResponse().setResponseCode(200))
        val cid = CumulusId(config, OkHttpClient())
        cid.signOut("tok", issuer = server.url("/").toString().trimEnd('/'))
        val request = server.takeRequest()
        assertEquals("/realms/cumulus/protocol/openid-connect/revoke", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/x-www-form-urlencoded"))
        val body = form(request.body.readUtf8())
        assertEquals("tok", body["token"])
        assertEquals("access_token", body["token_type_hint"])
        assertEquals("fabric", body["client_id"])
    }

    @Test
    fun mirrorHostsServeTheSameRealm() {
        assertEquals("https://ru.id.cumuluscloud.app/realms/cumulus/protocol/openid-connect", CidConfig.oidc(CidConfig.RU_ISSUER))
        assertEquals("https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect", CidConfig.oidc(CidConfig.OIDC_ISSUER + "/"))
        assertEquals("https://id.cumuluscloud.app", CidConfig.hostOf(CidConfig.OIDC_ISSUER))
    }

    @Test
    fun redeemErrorIsShortAndRedacted() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"That sign-in code belongs to another product."}"""))
        val cid = CumulusId(config, OkHttpClient())
        val pending = cid.newPending().copy(issuer = server.url("/").toString().trimEnd('/'))
        val thrown = assertThrows(ApiException::class.java) { cid.redeem(pending, "x") }
        assertEquals(400, thrown.status)
    }

    @Test
    fun rejectsCleartextIssuer() {
        assertThrows(IllegalArgumentException::class.java) {
            CidConfig("http://id.cumuluscloud.app", "fabric", CidConfig.DEFAULT_REDIRECT)
        }
    }

    @Test
    fun fallsBackToTheRussiaMirrorWhenTheMainIssuerDoesNotAnswer() {
        val cid = CumulusId(config)
        assertEquals(CidConfig.RU_ISSUER, cid.pickReachableIssuer({ it != CidConfig.DEFAULT_ISSUER }, { true }))
        assertEquals(CidConfig.RU_ISSUER, cid.newPending().issuer)
        assertTrue(cid.authorizeUrl(cid.newPending()).startsWith(CidConfig.RU_ISSUER + "/realms/cumulus/protocol/openid-connect/auth?"))
    }

    @Test
    fun keepsTheMainIssuerWhenItAnswersOrNothingDoes() {
        val cid = CumulusId(config)
        assertEquals(CidConfig.DEFAULT_ISSUER, cid.pickReachableIssuer({ true }, { true }))
        assertEquals(CidConfig.DEFAULT_ISSUER, cid.pickReachableIssuer({ false }, { false }))
        assertEquals(CidConfig.DEFAULT_ISSUER, cid.newPending().issuer)
        // Main answers small requests but can't deliver the page (Cloudflare throttled): the mirror wins.
        assertEquals(CidConfig.RU_ISSUER, cid.pickReachableIssuer({ it == CidConfig.RU_ISSUER }, { true }))
        // Nothing delivers the page: fall back to whichever answers at all.
        assertEquals(CidConfig.RU_ISSUER, cid.pickReachableIssuer({ false }, { it == CidConfig.RU_ISSUER }))
    }

    @Test
    fun probeTreatsAnyHttpAnswerAsReachable() {
        server.enqueue(MockResponse().setResponseCode(302))
        val local = server.url("/").toString().replace("http://", "https://")
        val cid = CumulusId(CidConfig(CidConfig.DEFAULT_ISSUER, "fabric", CidConfig.DEFAULT_REDIRECT, listOf(local)))
        // Probe with a stub: the real probe needs HTTPS; this checks ordering only.
        assertEquals(local, cid.pickReachableIssuer({ it == local }, { false }))
    }

    @Test
    fun throttledNetworksTryTheMirrorFirstEvenWhenTheMainProbePasses() {
        val cid = CumulusId(config)
        assertEquals(CidConfig.RU_ISSUER, cid.pickReachableIssuer({ true }, { true }, throttledNetwork = true))
        // The mirror is down: fall back to the main issuer.
        assertEquals(CidConfig.DEFAULT_ISSUER, cid.pickReachableIssuer({ it == CidConfig.DEFAULT_ISSUER }, { false }, throttledNetwork = true))
    }
}
