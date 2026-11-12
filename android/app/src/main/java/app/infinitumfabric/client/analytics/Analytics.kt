package app.infinitumfabric.client.analytics

import android.content.Context
import com.amplitude.android.Amplitude
import com.amplitude.android.AutocaptureOption
import com.amplitude.android.Configuration
import com.amplitude.android.TrackingOptions
import com.amplitude.core.ServerZone

/**
 * Privacy-first Amplitude Android SDK. Public API key only (not the Secret key).
 * Sessions, app lifecycles and screen views only. No element/frustration
 * autocapture, no remote config, no IP or precise-location fields.
 * Does not change any existing screen or layout.
 */
object Analytics {
    const val API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8"

    @Volatile
    private var client: Amplitude? = null

    fun start(context: Context) {
        if (client != null) return
        val tracking = TrackingOptions()
            .disableIpAddress()
            .disableCity()
            .disableDma()
            .disableLatLng()
            .disableAdid()
            .disableAppSetId()
        val config = Configuration(
            apiKey = API_KEY,
            context = context.applicationContext,
            serverZone = ServerZone.US,
            trackingOptions = tracking,
            useAdvertisingIdForDeviceId = false,
            useAppSetIdForDeviceId = false,
            locationListening = false,
            enableDiagnostics = false,
            enableAutocaptureRemoteConfig = false,
            autocapture = setOf(
                AutocaptureOption.SESSIONS,
                AutocaptureOption.APP_LIFECYCLES,
                AutocaptureOption.SCREEN_VIEWS,
            ),
        )
        client = Amplitude(config)
    }
}
