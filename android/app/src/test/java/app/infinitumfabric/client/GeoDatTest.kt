package app.infinitumfabric.client

import app.infinitumfabric.client.domain.DomainKind
import app.infinitumfabric.client.domain.GeoHook
import app.infinitumfabric.client.domain.GeoLists
import app.infinitumfabric.client.domain.GeoRoutingSettings
import app.infinitumfabric.client.domain.MemoryKeyValue
import app.infinitumfabric.client.domain.geoFeatureEnabled
import app.infinitumfabric.client.domain.signInNotice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GeoDatTest {
    @Test
    fun handcraftedProtobufMapsCountryAndCategory() {
        val cidr = lenField(1, byteArrayOf(1, 2, 3, 0)) + varintField(2, 24)
        val geoip = lenField(1, byteArrayOf(0x55, 0x53)) + lenField(2, cidr)
        val lists = GeoLists.decode(lenField(1, geoip), byteArrayOf())
        assertEquals("US", lists.countryOf("1.2.3.4"))
        assertNull(lists.countryOf("1.2.4.4"))

        val domain = varintField(1, DomainKind.DOMAIN) + lenField(2, "example.com".toByteArray())
        val site = lenField(1, "example".toByteArray()) + lenField(2, domain)
        val sites = GeoLists.decode(byteArrayOf(), lenField(1, site))
        assertEquals(listOf("example"), sites.categoriesOf("a.example.com"))
        assertEquals(emptyList<String>(), sites.categoriesOf("notexample.com"))
    }

    @Test
    fun syntheticFixturesMatchTheCoreLookups() {
        val lists = GeoLists.decode(fixture("synthetic-geoip.dat"), fixture("synthetic-geosite.dat"))
        assertEquals("US", lists.countryOf("1.2.3.4"))
        assertEquals("US", lists.countryOf("1.2.3.255"))
        assertNull(lists.countryOf("1.2.4.0"))
        assertEquals("US", lists.countryOf("198.51.100.9"))
        assertEquals("DE", lists.countryOf("198.51.100.10"))
        assertEquals("FR", lists.countryOf("198.51.100.200"))
        assertEquals("DE", lists.countryOf("203.0.113.10"))
        assertNull(lists.countryOf("203.0.113.11"))
        assertEquals("SE", lists.countryOf("2001:db8::1"))
        assertEquals("SE", lists.countryOf("[2001:db8::1]"))
        assertNull(lists.countryOf("2001:db9::1"))
        assertNull(lists.countryOf("10.9.8.7"))
        assertEquals(listOf("PRIVATE", "ZZ"), lists.matches("10.9.8.7"))
        assertEquals(emptyList<String>(), lists.matches("9.9.9.9"))
        assertEquals(listOf("ZZ"), lists.matches("192.0.2.5"))
        assertNull(lists.countryOf("192.0.2.5"))
        assertEquals(listOf("example"), lists.categoriesOf("Example.COM"))
        assertEquals(listOf("example"), lists.categoriesOf("a.example.com"))
        assertEquals(emptyList<String>(), lists.categoriesOf("notexample.com"))
        assertEquals(listOf("news"), lists.categoriesOf("news.example"))
        assertEquals(emptyList<String>(), lists.categoriesOf("www.news.example"))
        assertEquals(listOf("plain"), lists.categoriesOf("mykeyword.test"))
        assertEquals(listOf("chat"), lists.categoriesOf("only.fabric.test"))
        assertEquals(emptyList<String>(), lists.categoriesOf("sub.only.fabric.test"))
        assertThrows(IllegalArgumentException::class.java) {
            GeoLists.decode(byteArrayOf(0x0a, 0x05, 0x0a), byteArrayOf())
        }
    }

    @Test
    fun hookDefaultsOffAndLeavesTheSignInNoticeAlone() {
        val settings = GeoRoutingSettings(MemoryKeyValue())
        val lists = GeoLists.decode(fixture("synthetic-geoip.dat"), fixture("synthetic-geosite.dat"))
        val hook = GeoHook(settings = settings, env = { null }, lists = { lists })
        assertFalse(settings.isEnabled())
        assertFalse(hook.enabled())
        assertNull(hook.labelForHost("1.2.3.4"))
        assertNull(hook.labelForHost("a.example.com"))
        val base = "Relay health is ok. This build does not register a device."
        assertEquals(base, signInNotice(null))
        assertEquals(base, signInNotice(hook.labelForHost("1.2.3.4")))

        assertFalse(geoFeatureEnabled("0", true))
        assertFalse(geoFeatureEnabled("maybe", true))
        assertTrue(geoFeatureEnabled(null, true))
        val forcedOff = GeoHook(settings = settings, env = { "off" }, lists = { lists })
        settings.setEnabled(true)
        assertTrue(settings.isEnabled())
        assertFalse(forcedOff.enabled())
        assertNull(forcedOff.labelForHost("1.2.3.4"))

        val enabled = GeoHook(settings = settings, env = { null }, lists = { lists })
        assertTrue(enabled.enabled())
        assertEquals("geo_country=US", enabled.labelForHost("1.2.3.4"))
        assertEquals("geo_categories=example", enabled.labelForHost("a.example.com"))
        assertEquals("$base geo_country=US", signInNotice(enabled.labelForHost("1.2.3.4")))
        settings.setEnabled(false)
        assertFalse(GeoRoutingSettings(MemoryKeyValue()).isEnabled())
    }

    private fun fixture(name: String): ByteArray {
        val stream = checkNotNull(javaClass.classLoader?.getResourceAsStream(name)) { name }
        return stream.use { it.readBytes() }
    }

    private fun varint(value: Int): ByteArray {
        val out = ArrayList<Byte>()
        var rest = value
        while (rest > 127) {
            out.add(((rest and 0x7f) or 0x80).toByte())
            rest /= 128
        }
        out.add(rest.toByte())
        return out.toByteArray()
    }

    private fun lenField(field: Int, data: ByteArray): ByteArray = varint(field * 8 + 2) + varint(data.size) + data

    private fun varintField(field: Int, value: Int): ByteArray = varint(field * 8) + varint(value)
}

private operator fun ByteArray.plus(other: ByteArray): ByteArray {
    val out = ByteArray(size + other.size)
    System.arraycopy(this, 0, out, 0, size)
    System.arraycopy(other, 0, out, size, other.size)
    return out
}
