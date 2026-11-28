package app.infinitumfabric.client

import android.view.WindowManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
    fun showsCumulusIdSignInAndSecureWindow() {
        rule.onNodeWithText("FabriC++").assertIsDisplayed()
        rule.onNodeWithText("Infinitum Corporation®").assertIsDisplayed()
        rule.onNodeWithText("Sign in with Cumulus ID").assertIsDisplayed()
        rule.onNodeWithText("Create a Cumulus ID").assertIsDisplayed()
        rule.onNodeWithTag("advanced").performClick()
        rule.onNodeWithTag("homeserver").assertIsDisplayed()
        val flags = rule.activity.window.attributes.flags
        assertTrue(flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
    }
}
