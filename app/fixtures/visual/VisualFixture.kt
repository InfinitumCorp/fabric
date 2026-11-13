package com.infinitum.fabric.fixture

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import expo.modules.fabricmatrix.Engines
import expo.modules.fabricmatrix.MatrixEngine
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * TEST-ONLY visual-review fixture (diagnostic build only; never part of the app APK).
 * Signs the app's own engine in as a throwaway owner (credentials only from instrumentation args),
 * creates a real encrypted DM with a throwaway peer, and exchanges sample non-sensitive messages.
 * Prints user/room ids only. The owner stays signed in for review; the peer's local store is wiped.
 */
@RunWith(AndroidJUnit4::class)
class VisualFixture {
  @Test fun prepare() = runBlocking {
    val a = InstrumentationRegistry.getArguments(); val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    val hs = a.getString("hs")!!; val o = a.getString("oUser")!!; val p = a.getString("pUser")!!
    val owner = Engines.get(ctx); val peer = MatrixEngine(File(ctx.noBackupFilesDir, "fixture-peer"), "fixture_peer_wrap")
    try {
      withTimeout(240_000) {
        val oid = owner.login(hs, o, a.getString("oPw")!!); val pid = peer.login(hs, p, a.getString("pPw")!!)
        val om = owner.messenger!!; val pm = peer.messenger!!; om.start(); pm.start()
        val room = om.createDm(pid.userId)
        while (pm.rooms().none { it.roomId == room }) delay(500)
        pm.join(room); pm.open(room); om.open(room)
        om.send(room, "Hello from the visual fixture (sample text).")
        while (pm.messages(room).none { !it.mine && it.body != null }) delay(500)
        pm.send(room, "Hi! This is a sample reply from the throwaway peer.")
        while (om.messages(room).none { !it.mine && it.body != null }) delay(500)
        om.send(room, "Sample message three: encrypted end to end.")
        delay(3000)
        android.util.Log.i("FabricFixture", "READY owner=${oid.userId} peer=${pid.userId} room=$room")
        println("FIXTURE_READY owner=${oid.userId} peer=${pid.userId} room=$room")
        om.stop(); pm.stop()
      }
    } finally { peer.logoutAndWipe() }
  }
}
