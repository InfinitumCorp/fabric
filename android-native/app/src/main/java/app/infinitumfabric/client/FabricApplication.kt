package app.infinitumfabric.client

import android.app.Application

/** Process entry. FabriC++ does not ship analytics or a third-party tracker. */
class FabricApplication : Application() {
    override fun onCreate() {
        super.onCreate()
    }
}
