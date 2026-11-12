package app.infinitumfabric.client

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.telephony.TelephonyManager
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent
import app.infinitumfabric.client.data.PrefsSessionStore
import app.infinitumfabric.client.ui.FabricApp
import app.infinitumfabric.client.ui.FabricTheme
import app.infinitumfabric.client.analytics.Analytics

class MainActivity : ComponentActivity() {
    private val model: FabricViewModel by viewModels { FabricViewModelFactory(PrefsSessionStore(applicationContext)) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Analytics.start(this)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        if (savedInstanceState == null) {
            model.chooseCidIssuer(throttledNetwork = throttledCountry())
            handleReturn(intent)
        }
        setContent {
            FabricTheme {
                FabricApp(model, openCumulusId = ::openCumulusId)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleReturn(intent)
    }

    private fun handleReturn(intent: Intent?) {
        val data = intent?.data ?: return
        if (intent.action == Intent.ACTION_VIEW) {
            model.handleCidReturn(data.toString())
            // Do not process the same code twice after a configuration change.
            setIntent(Intent(this, MainActivity::class.java))
        }
    }

    /** True when the mobile network or the SIM is Russian or Belarusian (Cloudflare is throttled there). */
    private fun throttledCountry(): Boolean = try {
        val tm = getSystemService(TELEPHONY_SERVICE) as? TelephonyManager
        listOfNotNull(tm?.networkCountryIso, tm?.simCountryIso).any { it.equals("ru", true) || it.equals("by", true) }
    } catch (_: Exception) {
        false
    }

    /** Opens Cumulus ID in a Custom Tab (falls back to the default browser). */
    private fun openCumulusId(create: Boolean) {
        val uri = Uri.parse(model.beginCidSignIn(create))
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, uri)
        } catch (_: ActivityNotFoundException) {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (_: ActivityNotFoundException) {
                model.reportNoBrowser()
            }
        }
    }
}
