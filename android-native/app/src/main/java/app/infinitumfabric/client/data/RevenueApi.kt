package app.infinitumfabric.client.data

import app.infinitumfabric.client.domain.redact
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URI

/**
 * Plans and billing through the Infinitum revenue API (Worker `infinitum-revenue`). The revenue
 * API holds the Stripe keys; this app never holds a Stripe secret or publishable key. Calls carry
 * the signed-in Cumulus ID access token. Checkout and the billing portal come back as Stripe URLs
 * that the app opens in a Custom Tab.
 */
class RevenueApi(
    private val http: OkHttpClient = FabricApi.defaultClient(),
    baseUrl: String,
    policy: BaseUrlPolicy = BaseUrlPolicy.httpsOnly,
) {
    private val baseUrl: String = policy.normalize(baseUrl)

    /** Public catalog, FABRIC plans only. Contract plans are not offered in the app. */
    fun catalog(): List<BillingPlan> {
        val plans = request("GET", "/v1/catalog", token = null).optJSONArray("plans") ?: return emptyList()
        return buildList {
            for (i in 0 until plans.length()) {
                val p = plans.optJSONObject(i) ?: continue
                if (p.optString("product") != PRODUCT) continue
                val channel = p.optString("channel")
                if (channel == "contract") continue
                val kinds = p.optJSONArray("allowedKinds")
                add(
                    BillingPlan(
                        id = p.optString("id"),
                        name = p.optString("name"),
                        channel = channel,
                        priceCents = p.optInt("priceCents"),
                        interval = p.optString("interval", "month"),
                        perSeat = p.optBoolean("perSeat"),
                        businessOnly = kinds != null && (0 until kinds.length()).none { kinds.optString(it) == "individual" },
                    ),
                )
            }
        }
    }

    /** The person's FABRIC entitlement, or null when the revenue API has none for them. */
    fun entitlement(token: String): BillingEntitlement? {
        val products = request("GET", "/v1/me/entitlements", token).optJSONArray("products") ?: return null
        for (i in 0 until products.length()) {
            val p = products.optJSONObject(i) ?: continue
            if (p.optString("product") != PRODUCT) continue
            return BillingEntitlement(plan = p.optString("plan"), status = p.optString("status"), seats = p.optInt("seats", 1))
        }
        return null
    }

    /** Switches the account to a business organization (needed before business-only plans). */
    fun becomeBusiness(token: String, name: String?) {
        val body = JSONObject().put("kind", "business")
        if (!name.isNullOrBlank()) body.put("name", name.trim())
        try {
            request("POST", "/v1/me/org", token, body)
        } catch (e: ApiException) {
            // Already a business organization.
            if (e.status != 409) throw e
        }
    }

    /** Stripe Checkout URL for [planId]. [returnUrl] gets `?billing=success|cancelled` appended. */
    fun checkout(token: String, planId: String, quantity: Int, returnUrl: String?): String {
        val body = JSONObject().put("planId", planId).put("quantity", quantity)
        if (returnUrl != null) body.put("returnUrl", returnUrl)
        return stripeUrl(request("POST", "/v1/subscriptions/checkout", token, body))
    }

    /** Stripe customer portal URL (change plan or seats, cancel, payment method, invoices). */
    fun portal(token: String, returnUrl: String?): String {
        val body = JSONObject()
        if (returnUrl != null) body.put("returnUrl", returnUrl)
        return stripeUrl(request("POST", "/v1/billing/portal", token, body))
    }

    private fun stripeUrl(json: JSONObject): String {
        val url = json.optString("url")
        val parsed = try {
            URI(url)
        } catch (_: Exception) {
            null
        }
        // Only ever open an https page from the revenue API, never another scheme.
        if (parsed?.scheme?.lowercase() != "https" || parsed.host.isNullOrBlank()) throw ApiException(502, "bad_billing_url")
        return url
    }

    private fun request(method: String, path: String, token: String?, body: JSONObject? = null): JSONObject {
        val builder = Request.Builder()
            .url(baseUrl + path)
            .header("Accept", "application/json")
            .header("User-Agent", "FabricAndroid/0.1.0")
        if (token != null) builder.header("Authorization", "Bearer $token")
        if (method == "POST") {
            builder.post((body ?: JSONObject()).toString().toRequestBody(JSON))
        } else {
            builder.get()
        }
        http.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val message = try {
                    val err = JSONObject(text)
                    err.optJSONObject("error")?.optString("message")?.takeIf { it.isNotBlank() }
                        ?: err.optString("error").takeIf { it.isNotBlank() }
                } catch (_: Exception) {
                    null
                } ?: "http_${response.code}"
                throw ApiException(response.code, redact(message).take(120))
            }
            if (text.isBlank()) return JSONObject()
            return JSONObject(text)
        }
    }

    companion object {
        const val PRODUCT = "fabric"
        const val BUSINESS_PLAN = "fabric_business"
        private val JSON = "application/json".toMediaType()

        /** Reads `?billing=success|cancelled` from a billing return link. Null when it is not one. */
        fun parseBillingReturn(uri: String, returnUrl: String = BILLING_RETURN_URL): BillingReturn? {
            val parsed = try {
                URI(uri)
            } catch (_: Exception) {
                return null
            }
            val app = parsed.scheme == "infinitumfabric" && parsed.host == "billing" && parsed.path == "/return"
            val link = URI(returnUrl).let { parsed.scheme == "https" && parsed.host == it.host && parsed.path == it.path }
            if (!app && !link) return null
            val value = parsed.rawQuery.orEmpty().split('&')
                .map { it.split('=', limit = 2) }
                .firstOrNull { it[0] == "billing" }
                ?.getOrNull(1)
            return when (value) {
                "success" -> BillingReturn.Success
                "cancelled" -> BillingReturn.Cancelled
                else -> BillingReturn.Unknown
            }
        }

        /** Verified App Link (see AndroidManifest and landing/public/billing/return.html). */
        const val BILLING_RETURN_URL = "https://infinitumfabric.app/billing/return"
    }
}

data class BillingPlan(
    val id: String,
    val name: String,
    val channel: String,
    val priceCents: Int,
    val interval: String,
    val perSeat: Boolean,
    val businessOnly: Boolean,
)

data class BillingEntitlement(val plan: String, val status: String, val seats: Int)

enum class BillingReturn { Success, Cancelled, Unknown }
