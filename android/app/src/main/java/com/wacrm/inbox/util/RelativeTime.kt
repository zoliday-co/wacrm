package com.wacrm.inbox.util

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** WhatsApp-style relative timestamps for inbox rows and bubbles. */
fun relativeTime(millis: Long, nowMillis: Long = System.currentTimeMillis()): String {
    if (millis <= 0L) return ""
    val diff = nowMillis - millis
    val minute = 60_000L
    val hour = 60 * minute
    val day = 24 * hour
    return when {
        diff < minute -> "now"
        diff < hour -> "${diff / minute}m"
        diff < day -> "${diff / hour}h"
        diff < 7 * day -> "${diff / day}d"
        else -> SimpleDateFormat("dd MMM", Locale.getDefault()).format(Date(millis))
    }
}

fun bubbleTime(millis: Long): String {
    if (millis <= 0L) return ""
    return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(millis))
}
