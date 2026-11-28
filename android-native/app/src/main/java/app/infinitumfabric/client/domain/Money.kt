package app.infinitumfabric.client.domain

import kotlin.math.abs

fun formatUsdFromCents(cents: Int): String {
    val negative = cents < 0
    val value = abs(cents)
    val dollars = value / 100
    val remainder = (value % 100).toString().padStart(2, '0')
    return (if (negative) "-" else "") + "$" + dollars + "." + remainder
}

/** "Free", or "$8.00 / month per seat". */
fun formatPlanPrice(cents: Int, interval: String, perSeat: Boolean): String =
    if (cents == 0) "Free" else formatUsdFromCents(cents) + " / " + interval + if (perSeat) " per seat" else ""
