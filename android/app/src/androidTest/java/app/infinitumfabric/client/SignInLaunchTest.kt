package app.infinitumfabric.client

import android.view.WindowManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SignInLaunchTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun showsProductBrandingDefaultRelayAndSecureWindow() {
        rule.onNodeWithText("FabriC++").assertIsDisplayed()
        rule.onNodeWithText("Infinitum Corporation®").assertIsDisplayed()
        rule.onNodeWithTag("homeserver").assertIsDisplayed()
        val flags = rule.activity.window.attributes.flags
        assertTrue(flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
    }
}
