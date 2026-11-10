package app.infinitumfabric.client

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
import app.infinitumfabric.client.ui.FabricApp
import app.infinitumfabric.client.ui.FabricTheme
import app.infinitumfabric.client.analytics.Analytics

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Analytics.start(this)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        setContent {
            FabricTheme {
                val model: FabricViewModel = viewModel(factory = FabricViewModelFactory())
                FabricApp(model)
            }
        }
    }
}
