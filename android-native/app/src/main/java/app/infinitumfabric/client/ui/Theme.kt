package app.infinitumfabric.client.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val Paper = Color(0xFFFFFFFF)
val Ink = Color(0xFF111820)
val Muted = Color(0xFF52606B)
val Line = Color(0xFFD6DCE1)
val Accent = Color(0xFF2454DD)

private val Square = RoundedCornerShape(0.dp)

@Composable
fun FabricTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Accent,
            onPrimary = Color.White,
            background = Paper,
            onBackground = Ink,
            surface = Paper,
            onSurface = Ink,
            outline = Line,
        ),
        typography = Typography(
            headlineMedium = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.Normal,
                fontSize = 28.sp,
                letterSpacing = (-0.4).sp,
                color = Ink,
            ),
            titleMedium = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.Normal,
                fontSize = 18.sp,
                color = Ink,
            ),
            bodyMedium = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.Normal,
                fontSize = 16.sp,
                color = Ink,
            ),
            bodySmall = TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.Normal,
                fontSize = 13.sp,
                color = Muted,
            ),
        ),
        shapes = Shapes(
            extraSmall = Square,
            small = Square,
            medium = Square,
            large = Square,
            extraLarge = Square,
        ),
        content = content,
    )
}
