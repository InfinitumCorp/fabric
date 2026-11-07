package expo.modules.fabricmatrix

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/** Normal builds must keep FLAG_SECURE: the diagnostic screenshot switch is off unless set at compile time. */
@RunWith(AndroidJUnit4::class)
class SecureDefaultTest {
  @Test fun diagnosticScreenshotsOffByDefault() = assertFalse(BuildConfig.DIAGNOSTIC_SCREENSHOTS)
}
