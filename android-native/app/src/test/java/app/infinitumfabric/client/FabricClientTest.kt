package app.infinitumfabric.client

import app.infinitumfabric.client.data.ApiRoutes
import app.infinitumfabric.client.data.BaseUrlPolicy
import app.infinitumfabric.client.data.FabricApi
import app.infinitumfabric.client.domain.formatUsdFromCents
import app.infinitumfabric.client.domain.isValidHandle
import app.infinitumfabric.client.domain.redact
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList

class FabricClientTest {
    private lateinit var server: MockWebServer
    private val paths = CopyOnWriteArrayList<String>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                paths += "${request.method} $path"
                if (request.getHeader("Authorization") != null) {
                    return MockResponse().setResponseCode(500).setBody("""{"error":"unexpected authorization"}""")
                }
                return when (path) {
                    "/api/health" -> json("""{"ok":true}""")
                    "/api/purposes" -> json(
                        """{"usage":{"label":"Usage analytics","detail":"Aggregate counts.","weight":1},""" +
                            """"network":{"label":"Network quality","detail":"Latency.","weight":0.5}}""",
                    )
                    "/api/economy/preview?revenue=0" -> json(
                        """{"revenueCents":0,"poolCents":0,"infinitumCents":0,"participants":0,"fabPerUsd":10}""",
                    )
                    "/api/ledger" -> json("""{"valid":true,"length":1,"head":"abc123"}""")
                    "/api/cid" -> json("""{"enabled":false,"required":false}""")
                    "/api/ice" -> json("""{"iceServers":[{}],"sfu":false,"turn":false}""")
                    "/api/models" -> json("""{"available":false}""")
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":"not found"}""")
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun defaultBaseUrlIsTheProductDomain() {
        assertEquals("https://infinitumfabric.app", ApiRoutes.DEFAULT_BASE_URL)
        assertEquals("arm64-v8a", app.infinitumfabric.client.data.SupportedDevices.PRIMARY_ABI)
        assertEquals(35, app.infinitumfabric.client.data.SupportedDevices.TARGET_SDK)
    }

    @Test
    fun httpsPolicyRejectsCleartextAndUserInfo() {
        assertEquals(
            "https://infinitumfabric.app",
            BaseUrlPolicy.httpsOnly.normalize(" https://infinitumfabric.app/ "),
        )
        assertThrows(IllegalArgumentException::class.java) {
            BaseUrlPolicy.httpsOnly.normalize("http://infinitumfabric.app")
        }
        assertThrows(IllegalArgumentException::class.java) {
            BaseUrlPolicy.httpsOnly.normalize("http://127.0.0.1:8787")
        }
        assertThrows(IllegalArgumentException::class.java) {
            BaseUrlPolicy.httpsOnly.normalize("https://user:secret@infinitumfabric.app")
        }
    }

    @Test
    fun readsRelayRoutesAndNeverCallsSettle() {
        val api = FabricApi(
            http = OkHttpClient(),
            baseUrl = server.url("/").toString(),
            policy = loopback,
        )
        assertTrue(api.health().ok)
        val purposes = api.purposes()
        assertEquals(listOf("network", "usage"), purposes.map { it.key })
        assertEquals("Usage analytics", purposes.first { it.key == "usage" }.label)
        val preview = api.preview()
        assertEquals(0, preview.revenueCents)
        assertEquals(10, preview.fabPerUsd)
        val ledger = api.ledger()
        assertTrue(ledger.valid)
        assertEquals(1, ledger.length)
        val status = api.status()
        assertFalse(status.cidEnabled)
        assertFalse(status.turn)
        assertEquals(1, status.iceServerCount)
        assertFalse(status.modelsAvailable)
        assertTrue(paths.none { it.contains(ApiRoutes.SETTLE) })
        assertTrue(paths.none { it.startsWith("POST") })
    }

    @Test
    fun httpErrorDoesNotEchoABodySecret() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return MockResponse().setResponseCode(403).setBody("""{"error":"password=s3cret-value"}""")
            }
        }
        val api = FabricApi(baseUrl = server.url("/").toString(), policy = loopback)
        val error = assertThrows(app.infinitumfabric.client.data.ApiException::class.java) { api.health() }
        assertFalse(error.message.orEmpty().contains("s3cret-value"))
        assertTrue(redact(error.message.orEmpty()).contains("[redacted]") || !error.message.orEmpty().contains("password="))
    }

    @Test
    fun handlesAndMoneyMatchTheRelay() {
        assertTrue(isValidHandle("@ada.veil"))
        assertTrue(isValidHandle("  @ADA.veil "))
        assertFalse(isValidHandle("@a.veil"))
        assertFalse(isValidHandle("@alice:infinitumfabric.app"))
        assertEquals("$0.00", formatUsdFromCents(0))
        assertEquals("$70.00", formatUsdFromCents(7000))
    }

    @Test
    fun redactsTokensAndHandles() {
        val out = redact("send @ada.veil Bearer syt_abc123 password=\"meet at 9\"")
        assertFalse(out.contains("ada"))
        assertFalse(out.contains("syt_abc123"))
        assertFalse(out.contains("meet at 9"))
        assertTrue(out.contains("[handle]"))
        assertTrue(out.contains("Bearer [token]"))
    }

    private val loopback = BaseUrlPolicy { raw ->
        val uri = URI(raw.trim().trimEnd('/'))
        check(uri.scheme == "http")
        check(uri.host == "127.0.0.1" || uri.host == "localhost")
        raw.trim().trimEnd('/')
    }

    private fun json(body: String) = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
