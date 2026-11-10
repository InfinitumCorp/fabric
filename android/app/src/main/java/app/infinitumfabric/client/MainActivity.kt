package app.infinitumfabric.client

import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.viewmodel.compose.viewModel
import app.infinitumfabric.client.ads.Ads
import app.infinitumfabric.client.ui.FabricApp
import app.infinitumfabric.client.ui.FabricTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        enableEdgeToEdge()
        setContent {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f)) {
                    FabricTheme {
                        val model: FabricViewModel = viewModel(factory = FabricViewModelFactory())
                        FabricApp(model)
                    }
                }
                // Collapses to zero height when ads are off or a banner does not load.
                AndroidView(
                    modifier = Modifier.fillMaxWidth(),
                    factory = { ctx ->
                        FrameLayout(ctx).apply {
                            visibility = View.GONE
                            Ads.attach(this@MainActivity, this)
                        }
                    },
                )
            }
        }
    }
}
