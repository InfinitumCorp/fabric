package app.infinitumfabric.client.domain

import java.io.File
import java.nio.charset.StandardCharsets
import java.util.Locale

object DomainKind {
    const val PLAIN = 0
    const val REGEX = 1
    const val DOMAIN = 2
    const val FULL = 3
}

class GeoLists(private val geoip: GeoIpList, private val geosite: GeoSiteList) {
    fun countryOf(ip: String): String? = geoip.countryOf(ip)

    fun matches(ip: String): List<String> = geoip.matches(ip)

    fun categoriesOf(domain: String): List<String> = geosite.categoriesOf(domain)

    fun labelForHost(host: String): String? {
        if (parseIp(host) != null) {
            val country = countryOf(host) ?: return null
            return "geo_country=${sanitizeToken(country)}"
        }
        val categories = categoriesOf(host)
        if (categories.isEmpty()) return null
        return "geo_categories=" + categories.joinToString(",") { sanitizeToken(it) }
    }

    companion object {
        fun decode(geoip: ByteArray, geosite: ByteArray): GeoLists = GeoLists(GeoIpList.decode(geoip), GeoSiteList.decode(geosite))

        fun loadDirectory(dir: File): GeoLists? {
            val ipFile = File(dir, "geoip.dat")
            val siteFile = File(dir, "geosite.dat")
            if (!ipFile.isFile || !siteFile.isFile) return null
            return decode(ipFile.readBytes(), siteFile.readBytes())
        }
    }
}

class GeoIpList private constructor(private val entries: List<GeoIpEntry>) {
    fun countryOf(ip: String): String? {
        val bytes = parseIp(ip) ?: return null
        var bestCode: String? = null
        var bestPrefix = -1
        var bestIndex = Int.MAX_VALUE
        entries.forEachIndexed { index, entry ->
            if (entry.reverseMatch || !entry.code.matches(COUNTRY)) return@forEachIndexed
            val prefix = entry.prefixMatch(bytes) ?: return@forEachIndexed
            if (bestCode == null || prefix > bestPrefix || (prefix == bestPrefix && index < bestIndex)) {
                bestCode = entry.code.uppercase(Locale.ROOT)
                bestPrefix = prefix
                bestIndex = index
            }
        }
        return bestCode
    }

    fun matches(ip: String): List<String> {
        val bytes = parseIp(ip) ?: return emptyList()
        val codes = ArrayList<String>()
        for (entry in entries) {
            if (entry.code.isEmpty() || entry.prefixMatch(bytes) == null) continue
            if (!codes.contains(entry.code)) codes.add(entry.code)
        }
        return codes
    }

    companion object {
        private val COUNTRY = Regex("^[A-Za-z]{2}$")

        fun decode(bytes: ByteArray): GeoIpList {
            val entries = ArrayList<GeoIpEntry>()
            var i = 0
            while (i < bytes.size) {
                val key = readVarint(bytes, i, bytes.size)
                val field = (key.value ushr 3).toInt()
                val wire = (key.value and 7L).toInt()
                if (field == 1 && wire == 2) {
                    val slice = readLen(bytes, key.next, bytes.size)
                    entries.add(parseGeoIp(bytes, slice.start, slice.next))
                    i = slice.next
                } else {
                    i = skipValue(bytes, key.next, bytes.size, wire)
                }
            }
            return GeoIpList(entries)
        }
    }
}

class GeoSiteList private constructor(entries: List<GeoSiteEntry>) {
    private val byHost = HashMap<String, MutableList<IndexedRule>>()
    private val scans = ArrayList<IndexedRule>()

    init {
        for (entry in entries) {
            if (entry.category.isEmpty()) continue
            for (domain in entry.domains) {
                val value = domain.value.trim().lowercase(Locale.ROOT)
                if (value.isEmpty() || value.length > 512) continue
                if (domain.type == DomainKind.REGEX) {
                    if (domain.value.length > 512) continue
                    val regex = try {
                        Regex(domain.value)
                    } catch (_: Exception) {
                        continue
                    }
                    scans.add(IndexedRule(entry.category, domain.type, value, regex))
                    continue
                }
                if (domain.type == DomainKind.PLAIN) {
                    scans.add(IndexedRule(entry.category, domain.type, value, null))
                    continue
                }
                val rule = IndexedRule(entry.category, domain.type, value, null)
                byHost.getOrPut(value) { ArrayList() }.add(rule)
            }
        }
    }

    fun categoriesOf(domain: String): List<String> {
        val host = normalizeDomain(domain) ?: return emptyList()
        if (parseIp(host) != null) return emptyList()
        val found = linkedSetOf<String>()
        val labels = host.split(".")
        for (start in labels.indices) {
            val suffix = labels.subList(start, labels.size).joinToString(".")
            val rules = byHost[suffix] ?: continue
            for (rule in rules) {
                if (rule.value != suffix) continue
                if (rule.type == DomainKind.FULL && host == suffix) found.add(rule.category)
                if (rule.type == DomainKind.DOMAIN && (host == suffix || host.endsWith(".$suffix"))) found.add(rule.category)
            }
        }
        for (rule in scans) {
            if (rule.type == DomainKind.PLAIN && host.contains(rule.value)) found.add(rule.category)
            else if (rule.type == DomainKind.REGEX && rule.regex?.containsMatchIn(host) == true) found.add(rule.category)
        }
        return found.sorted()
    }

    companion object {
        fun decode(bytes: ByteArray): GeoSiteList {
            val entries = ArrayList<GeoSiteEntry>()
            var i = 0
            while (i < bytes.size) {
                val key = readVarint(bytes, i, bytes.size)
                val field = (key.value ushr 3).toInt()
                val wire = (key.value and 7L).toInt()
                if (field == 1 && wire == 2) {
                    val slice = readLen(bytes, key.next, bytes.size)
                    entries.add(parseGeoSite(bytes, slice.start, slice.next))
                    i = slice.next
                } else {
                    i = skipValue(bytes, key.next, bytes.size, wire)
                }
            }
            return GeoSiteList(entries)
        }
    }
}

private class GeoIpEntry(val code: String, private val cidrs: List<Cidr>, val reverseMatch: Boolean) {
    fun prefixMatch(ip: ByteArray): Int? {
        var matched = false
        var prefix = -1
        for (cidr in cidrs) {
            if (!cidrContains(ip, cidr.ip, cidr.prefix)) continue
            matched = true
            if (cidr.prefix > prefix) prefix = cidr.prefix
        }
        if (reverseMatch) return if (matched) null else -1
        return if (matched) prefix else null
    }
}

private class Cidr(val ip: ByteArray, val prefix: Int)

private class GeoSiteEntry(val category: String, val domains: List<DomainRule>)

private class DomainRule(val type: Int, val value: String)

private class IndexedRule(val category: String, val type: Int, val value: String, val regex: Regex?)

private class Varint(val value: Long, val next: Int)

private class Slice(val start: Int, val next: Int)

fun parseIp(input: String): ByteArray? {
    var value = input.trim().lowercase(Locale.ROOT)
    if (value.startsWith("[") && value.endsWith("]")) value = value.substring(1, value.length - 1)
    if (value.isEmpty()) return null
    if (value.contains(".")) {
        if (!value.contains(":")) return parseIpv4(value)
    } else if (!value.contains(":")) {
        return null
    }
    return parseIpv6(value)
}

fun normalizeDomain(input: String): String? {
    var host = input.trim().lowercase(Locale.ROOT)
    if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length - 1)
    if (host.endsWith(".")) host = host.dropLast(1)
    if (host.isEmpty() || host.length > 253) return null
    if (host.any { it.isWhitespace() || it == '/' || it == '@' || it == ':' || it == '\\' }) return null
    return host
}

fun sanitizeToken(value: String): String {
    val cleaned = value.replace(Regex("[^A-Za-z0-9._-]"), "")
    return if (cleaned.isEmpty()) "unknown" else cleaned
}

private fun parseIpv4(value: String): ByteArray? {
    val parts = value.split(".")
    if (parts.size != 4) return null
    val out = ByteArray(4)
    for (i in 0 until 4) {
        val part = parts[i]
        if (!part.matches(Regex("^[0-9]{1,3}$"))) return null
        if (part.length > 1 && part.startsWith("0")) return null
        val n = part.toInt()
        if (n > 255) return null
        out[i] = n.toByte()
    }
    return out
}

private fun parseIpv6(value: String): ByteArray? {
    val marker = value.indexOf("::")
    if (marker < 0) {
        val full = parseIpv6Side(value) ?: return null
        if (full.size != 8) return null
        return groupsToBytes(full)
    }
    if (value.indexOf("::", marker + 2) >= 0) return null
    val head = parseIpv6Side(value.substring(0, marker)) ?: return null
    val tail = parseIpv6Side(value.substring(marker + 2)) ?: return null
    val missing = 8 - head.size - tail.size
    if (missing < 1) return null
    return groupsToBytes(head + List(missing) { 0 } + tail)
}

private fun parseIpv6Side(side: String): List<Int>? {
    if (side.isEmpty()) return emptyList()
    val parts = side.split(":")
    val groups = ArrayList<Int>()
    for (i in parts.indices) {
        val part = parts[i]
        if (part.contains(".")) {
            if (i != parts.lastIndex) return null
            val v4 = parseIpv4(part) ?: return null
            groups.add(((v4[0].toInt() and 0xff) shl 8) or (v4[1].toInt() and 0xff))
            groups.add(((v4[2].toInt() and 0xff) shl 8) or (v4[3].toInt() and 0xff))
            continue
        }
        if (!part.matches(Regex("^[0-9a-f]{1,4}$"))) return null
        groups.add(part.toInt(16))
    }
    return groups
}

private fun groupsToBytes(groups: List<Int>): ByteArray {
    val out = ByteArray(16)
    for (i in 0 until 8) {
        out[i * 2] = ((groups[i] shr 8) and 0xff).toByte()
        out[i * 2 + 1] = (groups[i] and 0xff).toByte()
    }
    return out
}

private fun cidrContains(ip: ByteArray, network: ByteArray, prefix: Int): Boolean {
    if (ip.size != network.size) return false
    if (prefix < 0 || prefix > ip.size * 8) return false
    var bits = prefix
    var i = 0
    while (i < ip.size && bits > 0) {
        val take = if (bits >= 8) 8 else bits
        val mask = if (take == 8) 0xff else (0xff shl (8 - take)) and 0xff
        val ipByte = ip[i].toInt() and 0xff
        val netByte = network[i].toInt() and 0xff
        if ((ipByte and mask) != (netByte and mask)) return false
        bits -= take
        i++
    }
    return true
}

private fun readVarint(buf: ByteArray, offset: Int, end: Int): Varint {
    var value = 0L
    var shift = 0
    var pos = offset
    while (pos < end && shift <= 28) {
        val b = buf[pos].toInt() and 0xff
        pos++
        value += (b and 0x7f).toLong() shl shift
        if (b and 0x80 == 0) return Varint(value, pos)
        shift += 7
    }
    badGeo()
}

private fun skipValue(buf: ByteArray, offset: Int, end: Int, wire: Int): Int {
    if (wire == 0) return readVarint(buf, offset, end).next
    if (wire == 1) {
        if (offset + 8 > end) badGeo()
        return offset + 8
    }
    if (wire == 5) {
        if (offset + 4 > end) badGeo()
        return offset + 4
    }
    if (wire == 2) {
        val slice = readLen(buf, offset, end)
        return slice.next
    }
    badGeo()
}

private fun readLen(buf: ByteArray, offset: Int, end: Int): Slice {
    val len = readVarint(buf, offset, end)
    val start = len.next
    val next = start + len.value.toInt()
    if (len.value < 0 || next > end || next < start) badGeo()
    return Slice(start, next)
}

private fun readString(buf: ByteArray, start: Int, end: Int): String {
    return String(buf, start, end - start, StandardCharsets.UTF_8)
}

private fun parseGeoIp(buf: ByteArray, start: Int, end: Int): GeoIpEntry {
    var code = ""
    val cidrs = ArrayList<Cidr>()
    var reverseMatch = false
    var i = start
    while (i < end) {
        val key = readVarint(buf, i, end)
        val field = (key.value ushr 3).toInt()
        val wire = (key.value and 7L).toInt()
        if (field == 1 && wire == 2) {
            val slice = readLen(buf, key.next, end)
            code = readString(buf, slice.start, slice.next)
            i = slice.next
        } else if (field == 2 && wire == 2) {
            val slice = readLen(buf, key.next, end)
            cidrs.add(parseCidr(buf, slice.start, slice.next))
            i = slice.next
        } else if (field == 3 && wire == 0) {
            val value = readVarint(buf, key.next, end)
            reverseMatch = value.value != 0L
            i = value.next
        } else {
            i = skipValue(buf, key.next, end, wire)
        }
    }
    return GeoIpEntry(code, cidrs, reverseMatch)
}

private fun parseCidr(buf: ByteArray, start: Int, end: Int): Cidr {
    var ip = ByteArray(0)
    var prefix = 0
    var i = start
    while (i < end) {
        val key = readVarint(buf, i, end)
        val field = (key.value ushr 3).toInt()
        val wire = (key.value and 7L).toInt()
        if (field == 1 && wire == 2) {
            val slice = readLen(buf, key.next, end)
            ip = buf.copyOfRange(slice.start, slice.next)
            i = slice.next
        } else if (field == 2 && wire == 0) {
            val value = readVarint(buf, key.next, end)
            prefix = value.value.toInt()
            i = value.next
        } else {
            i = skipValue(buf, key.next, end, wire)
        }
    }
    if (ip.size != 4 && ip.size != 16) badGeo()
    if (prefix < 0 || prefix > ip.size * 8) badGeo()
    return Cidr(ip, prefix)
}

private fun parseGeoSite(buf: ByteArray, start: Int, end: Int): GeoSiteEntry {
    var category = ""
    val domains = ArrayList<DomainRule>()
    var i = start
    while (i < end) {
        val key = readVarint(buf, i, end)
        val field = (key.value ushr 3).toInt()
        val wire = (key.value and 7L).toInt()
        if (field == 1 && wire == 2) {
            val slice = readLen(buf, key.next, end)
            category = readString(buf, slice.start, slice.next)
            i = slice.next
        } else if (field == 2 && wire == 2) {
            val slice = readLen(buf, key.next, end)
            domains.add(parseDomain(buf, slice.start, slice.next))
            i = slice.next
        } else {
            i = skipValue(buf, key.next, end, wire)
        }
    }
    return GeoSiteEntry(category, domains)
}

private fun parseDomain(buf: ByteArray, start: Int, end: Int): DomainRule {
    var type = DomainKind.PLAIN
    var value = ""
    var i = start
    while (i < end) {
        val key = readVarint(buf, i, end)
        val field = (key.value ushr 3).toInt()
        val wire = (key.value and 7L).toInt()
        if (field == 1 && wire == 0) {
            val parsed = readVarint(buf, key.next, end)
            type = parsed.value.toInt()
            i = parsed.next
        } else if (field == 2 && wire == 2) {
            val slice = readLen(buf, key.next, end)
            value = readString(buf, slice.start, slice.next)
            i = slice.next
        } else {
            i = skipValue(buf, key.next, end, wire)
        }
    }
    return DomainRule(type, value)
}

private fun badGeo(): Nothing = throw IllegalArgumentException("truncated geo list")
