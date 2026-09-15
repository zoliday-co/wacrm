package com.wacrm.inbox.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF075E54),
    secondary = Color(0xFF128C7E),
    tertiary = Color(0xFF25D366),
    primaryContainer = Color(0xFFD9FDD3),
    onPrimaryContainer = Color(0xFF0B3D2E),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF4DB6AC),
    secondary = Color(0xFF26A69A),
    tertiary = Color(0xFF25D366),
    primaryContainer = Color(0xFF005C4B),
    onPrimaryContainer = Color(0xFFD9FDD3),
)

@Composable
fun WacrmTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content,
    )
}
