package app.infinitumfabric.client

import app.infinitumfabric.client.data.ApiException
import app.infinitumfabric.client.data.CidConfig
import app.infinitumfabric.client.data.CumulusId
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
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

    @Test
    fun authorizeUrlUsesPkceS256AndTheFabricClient() {
        val cid = CumulusId(config)
        val pending = cid.newPending()
        val url = cid.authorizeUrl(pending)
        assertTrue(url.startsWith("https://id.cumuluscloud.app/api/id/authorize?"))
        val q = query(url)
        assertEquals("fabric", q["client_id"])
        assertEquals("https://infinitumfabric.app/cid/return", q["redirect_uri"])
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
    fun redeemPostsCodeAndVerifierAndReadsProfile() {
        server.enqueue(
            MockResponse().setHeader("Content-Type", "application/json").setBody(
                """{"access_token":"tok","expires_in":600,"profile":{"cid":"c1","username":"ann","email":"ann@cumuluscloud.app","handle":"@ann.veil"}}""",
            ),
        )
        val cid = CumulusId(config, OkHttpClient())
        val pending = cid.newPending().copy(issuer = server.url("/").toString().trimEnd('/'))
        val session = cid.redeem(pending, "code1")
        val request = server.takeRequest()
        assertEquals("/api/id/token", request.path)
        val body = JSONObject(request.body.readUtf8())
        assertEquals("code1", body.getString("code"))
        assertEquals(pending.verifier, body.getString("code_verifier"))
        assertEquals("fabric", body.getString("client_id"))
        assertEquals("tok", session.token)
        assertEquals("ann@cumuluscloud.app", session.profile.display)
        assertTrue(session.isLive())
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
}
