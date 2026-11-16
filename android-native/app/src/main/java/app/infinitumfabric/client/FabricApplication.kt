package app.infinitumfabric.client

import android.app.Application
import com.amplitude.android.Amplitude
import com.amplitude.android.AutocaptureOption
import com.amplitude.android.Configuration
import com.amplitude.android.TrackingOptions
import com.amplitude.core.ServerZone

/**
 * Privacy-first Amplitude analytics (official Android SDK, US region).
 * Public API key only. Tracks screen views and sessions only; never identifies a user.
 * Off: element interactions, deep links, remote config, diagnostics, IP, city, DMA, lat/lng, advertising ID.
 */
class FabricApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            Amplitude(
                Configuration(
                    apiKey = AMPLITUDE_PUBLIC_API_KEY,
                    context = applicationContext,
                    serverZone = ServerZone.US,
                    autocapture = setOf(AutocaptureOption.SESSIONS, AutocaptureOption.SCREEN_VIEWS),
                    trackingOptions = TrackingOptions()
                        .disableCity()
                        .disableDma()
                        .disableLatLng()
                        .disableIpAddress()
                        .disableAdid(),
                    useAdvertisingIdForDeviceId = false,
                    useAppSetIdForDeviceId = false,
                    locationListening = false,
                    enableDiagnostics = false,
                    enableAutocaptureRemoteConfig = false,
                ),
            )
        } catch (_: Throwable) {
            // Analytics must never break the app.
        }
    }

    private companion object {
        const val AMPLITUDE_PUBLIC_API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8"
    }
}
