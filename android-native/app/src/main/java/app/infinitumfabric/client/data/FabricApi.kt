package app.infinitumfabric.client.data

import app.infinitumfabric.client.domain.redact
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class FabricApi(
    private val http: OkHttpClient = defaultClient(),
    baseUrl: String,
    policy: BaseUrlPolicy = BaseUrlPolicy.httpsOnly,
) {
    private val baseUrl: String = policy.normalize(baseUrl)

    fun health(): Health {
        val json = get(ApiRoutes.HEALTH)
        return Health(ok = json.optBoolean("ok", false))
    }

    fun purposes(): List<Purpose> {
        val json = get(ApiRoutes.PURPOSES)
        return buildList {
            val keys = json.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val item = json.optJSONObject(key) ?: continue
                add(
                    Purpose(
                        key = key,
                        label = item.optString("label"),
                        detail = item.optString("detail"),
                        weight = item.optDouble("weight"),
                    ),
                )
            }
        }.sortedBy { it.key }
    }

    fun preview(): EconomyPreview {
        val json = get(ApiRoutes.PREVIEW)
        return EconomyPreview(
            revenueCents = json.optInt("revenueCents"),
            poolCents = json.optInt("poolCents"),
            infinitumCents = json.optInt("infinitumCents"),
            participants = json.optInt("participants"),
            fabPerUsd = json.optInt("fabPerUsd"),
        )
    }

    fun ledger(): LedgerHead {
        val json = get(ApiRoutes.LEDGER)
        return LedgerHead(
            valid = json.optBoolean("valid"),
            length = json.optInt("length"),
            head = json.optString("head"),
        )
    }

    fun status(): RelayStatus {
        val cid = get(ApiRoutes.CID)
        val ice = get(ApiRoutes.ICE)
        val models = get(ApiRoutes.MODELS)
        val servers = ice.optJSONArray("iceServers")
        return RelayStatus(
            cidEnabled = cid.optBoolean("enabled"),
            cidRequired = cid.optBoolean("required"),
            sfu = ice.optBoolean("sfu"),
            turn = ice.optBoolean("turn"),
            iceServerCount = servers?.length() ?: 0,
            modelsAvailable = models.optBoolean("available"),
        )
    }

    private fun get(path: String): JSONObject {
        val request = Request.Builder()
            .url(baseUrl + path)
            .header("Accept", "application/json")
            .header("User-Agent", "FabricAndroid/0.1.0")
            .get()
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val code = redact(
                    try {
                        JSONObject(text).optString("error").ifBlank { "http_${response.code}" }
                    } catch (_: Exception) {
                        "http_${response.code}"
                    },
                ).take(80)
                throw ApiException(response.code, code)
            }
            if (text.isBlank()) return JSONObject()
            return JSONObject(text)
        }
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
