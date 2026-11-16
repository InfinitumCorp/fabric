package app.infinitumfabric.client

import app.infinitumfabric.client.data.ApiException
import app.infinitumfabric.client.data.BaseUrlPolicy
import app.infinitumfabric.client.data.BillingEntitlement
import app.infinitumfabric.client.data.BillingReturn
import app.infinitumfabric.client.data.RevenueApi
import app.infinitumfabric.client.domain.formatPlanPrice
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
import java.util.concurrent.CopyOnWriteArrayList

class RevenueApiTest {
    private lateinit var server: MockWebServer
    private val seen = CopyOnWriteArrayList<Triple<String, String?, String>>()
    private val routes = mutableMapOf<String, MockResponse>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val key = "${request.method} ${request.path}"
                seen += Triple(key, request.getHeader("Authorization"), request.body.readUtf8())
                return routes[key] ?: MockResponse().setResponseCode(404).setBody("""{"error":{"code":"not_found","message":"Not found"}}""")
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun api() = RevenueApi(
        http = OkHttpClient(),
        baseUrl = server.url("/").toString(),
        policy = BaseUrlPolicy { it.trim().trimEnd('/') },
    )

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun catalogKeepsFabricPlansAndDropsContractPlans() {
        routes["GET /v1/catalog"] = json(
            """{"plans":[
              {"id":"fabric_personal","product":"fabric","name":"FABRIC Personal","channel":"self_serve","priceCents":0,"interval":"month","allowedKinds":["individual","business","government"]},
              {"id":"fabric_business","product":"fabric","name":"FABRIC Business","channel":"self_serve","priceCents":800,"interval":"month","perSeat":true,"allowedKinds":["business","government"]},
              {"id":"fabric_gov","product":"fabric","name":"FABRIC Gov","channel":"sales_assisted","priceCents":5000,"interval":"month","allowedKinds":["government"]},
              {"id":"fabric_contract","product":"fabric","name":"Contract","channel":"contract","priceCents":0,"interval":"year"},
              {"id":"scalvs_pro","product":"scalvs","name":"SCALVS.ai Pro","channel":"self_serve","priceCents":2900,"interval":"month"}
            ]}""",
        )
        val plans = api().catalog()
        assertEquals(listOf("fabric_personal", "fabric_business", "fabric_gov"), plans.map { it.id })
        assertFalse(plans[0].businessOnly)
        assertTrue(plans[1].businessOnly)
        assertTrue(plans[1].perSeat)
        assertEquals(800, plans[1].priceCents)
        assertEquals("sales_assisted", plans[2].channel)
        // The catalog is public: no token is sent.
        assertNull(seen.single().second)
    }

    @Test
    fun entitlementReadsTheFabricProductWithTheToken() {
        routes["GET /v1/me/entitlements"] = json(
            """{"orgId":"org_1","products":[
              {"product":"scalvs","plan":"scalvs_free","status":"free","seats":1},
              {"product":"fabric","plan":"fabric_business","status":"active","seats":5}
            ]}""",
        )
        assertEquals(BillingEntitlement("fabric_business", "active", 5), api().entitlement("tok"))
        assertEquals("Bearer tok", seen.single().second)
    }

    @Test
    fun entitlementIsNullWithoutAFabricProduct() {
        routes["GET /v1/me/entitlements"] = json("""{"products":[]}""")
        assertNull(api().entitlement("tok"))
    }

    @Test
    fun businessUpgradeSwitchesOrgThenOpensCheckoutWithSeats() {
        routes["POST /v1/me/org"] = json("""{"id":"org_1","name":"Acme","kind":"business"}""")
        routes["POST /v1/subscriptions/checkout"] = json("""{"url":"https://checkout.stripe.com/c/pay/cs_1"}""")
        val api = api()
        api.becomeBusiness("tok", " Acme ")
        val url = api.checkout("tok", RevenueApi.BUSINESS_PLAN, 5, RevenueApi.BILLING_RETURN_URL)
        assertEquals("https://checkout.stripe.com/c/pay/cs_1", url)
        val org = JSONObject(seen[0].third)
        assertEquals("business", org.getString("kind"))
        assertEquals("Acme", org.getString("name"))
        val checkout = JSONObject(seen[1].third)
        assertEquals("fabric_business", checkout.getString("planId"))
        assertEquals(5, checkout.getInt("quantity"))
        assertEquals("https://infinitumfabric.app/billing/return", checkout.getString("returnUrl"))
        assertTrue(seen.all { it.second == "Bearer tok" })
    }

    @Test
    fun becomeBusinessToleratesAnAlreadyBusinessOrg() {
        routes["POST /v1/me/org"] = json("""{"error":{"code":"conflict","message":"already business"}}""", 409)
        api().becomeBusiness("tok", null)
        assertFalse(JSONObject(seen.single().third).has("name"))
    }

    @Test
    fun portalReturnsTheStripeUrl() {
        routes["POST /v1/billing/portal"] = json("""{"url":"https://billing.stripe.com/p/session/x"}""")
        assertEquals("https://billing.stripe.com/p/session/x", api().portal("tok", RevenueApi.BILLING_RETURN_URL))
    }

    @Test
    fun aNonHttpsBillingUrlIsRefused() {
        routes["POST /v1/billing/portal"] = json("""{"url":"javascript:alert(1)"}""")
        val e = assertThrows(ApiException::class.java) { api().portal("tok", null) }
        assertEquals("bad_billing_url", e.code)
    }

    @Test
    fun errorsCarryTheRevenueApiMessage() {
        routes["POST /v1/subscriptions/checkout"] =
            json("""{"error":{"code":"approval_required","message":"FABRIC Gov requires account approval"}}""", 403)
        val e = assertThrows(ApiException::class.java) { api().checkout("tok", "fabric_gov", 1, null) }
        assertEquals(403, e.status)
        assertEquals("FABRIC Gov requires account approval", e.code)
    }

    @Test
    fun billingReturnLinksAreParsed() {
        assertEquals(BillingReturn.Success, RevenueApi.parseBillingReturn("https://infinitumfabric.app/billing/return?billing=success&session_id=cs_1"))
        assertEquals(BillingReturn.Cancelled, RevenueApi.parseBillingReturn("infinitumfabric://billing/return?billing=cancelled"))
        assertEquals(BillingReturn.Unknown, RevenueApi.parseBillingReturn("https://infinitumfabric.app/billing/return"))
        assertNull(RevenueApi.parseBillingReturn("https://infinitumfabric.app/cid/return?code=x&state=y"))
        assertNull(RevenueApi.parseBillingReturn("https://evil.example/billing/return?billing=success"))
        assertNull(RevenueApi.parseBillingReturn("infinitumfabric://cid/return?code=x"))
    }

    @Test
    fun planPricesAreFormatted() {
        assertEquals("Free", formatPlanPrice(0, "month", false))
        assertEquals("$8.00 / month per seat", formatPlanPrice(800, "month", true))
    }
}
