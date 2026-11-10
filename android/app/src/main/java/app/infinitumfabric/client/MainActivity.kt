package app.infinitumfabric.client

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
import app.infinitumfabric.client.domain.GeoLists
import app.infinitumfabric.client.domain.GeoRoutingSettings
import app.infinitumfabric.client.domain.SharedPrefsStore
import app.infinitumfabric.client.ui.FabricApp
import app.infinitumfabric.client.ui.FabricTheme
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        val geoSettings = GeoRoutingSettings(SharedPrefsStore(getSharedPreferences("fabric_settings", MODE_PRIVATE)))
        val geoDir = File(filesDir, "geo")
        setContent {
            FabricTheme {
                val model: FabricViewModel = viewModel(
                    factory = FabricViewModelFactory(
                        geoSettings = geoSettings,
                        geoLoader = { GeoLists.loadDirectory(geoDir) },
                    ),
                )
                FabricApp(model)
            }
        }
    }
}
