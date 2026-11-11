package ru.kuzovpro.gatewaytest

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

class PdfNetworkTest {
    private val pdf = PdfPayload(PdfFixtures.onePage())
    private class Connection(private val status: Int, private val bytes: ByteArray, private val etag: String? = null,
                             private val mime: String = "application/pdf") : HttpURLConnection(URL(Protocol.ENDPOINT)) {
        val sent = ByteArrayOutputStream()
        var closed = false
        val fixedLength get() = fixedContentLength
        override fun getOutputStream() = sent
        override fun getResponseCode() = status
        override fun getInputStream() = ByteArrayInputStream(bytes)
        override fun getHeaderField(name: String): String? = if (name == "ETag") etag else null
        override fun getContentType() = mime
        override fun disconnect() { closed = true }
        override fun connect() {}
        override fun usingProxy() = false
    }

    @Test fun putUsesExactSignedHeadersAndBytesWithNoRedirects() {
        val c = Connection(200, byteArrayOf(), "\"${Protocol.hex(Base64.getDecoder().decode(pdf.md5))}\"")
        val result = HttpsPdfNetwork { c }.put(PdfFixtures.ticket(pdf), PdfFixtures.id, pdf)
        assertEquals("PUT", c.requestMethod)
        assertEquals(pdf.size, c.fixedLength)
        assertArrayEquals(pdf.bytes(), c.sent.toByteArray())
        assertEquals("application/pdf", c.getRequestProperty("Content-Type"))
        assertEquals(pdf.md5, c.getRequestProperty("Content-MD5"))
        assertEquals("*", c.getRequestProperty("If-None-Match"))
        assertFalse(c.instanceFollowRedirects)
        assertTrue(c.closed)
        assertTrue(result.md5Confirmed)
    }

    @Test fun missingOrWrongEtagAndRedirectsAreNotSuccessfulUploads() {
        for ((code, tag) in listOf(200 to null, 200 to "wrong", 307 to "wrong", 412 to null)) {
            val c = Connection(code, byteArrayOf(), tag)
            val result = HttpsPdfNetwork { c }.put(PdfFixtures.ticket(pdf), PdfFixtures.id, pdf)
            assertEquals(code, result.status)
            assertFalse(result.md5Confirmed)
            assertFalse(c.instanceFollowRedirects)
        }
    }

    @Test fun unsafeHostPathOrIncompleteSignedHeadersNeverOpenConnection() {
        val valid = PdfFixtures.ticket(pdf)
        val variants = listOf(
            UploadTicket(valid.url.replace("https://", "http://"), valid.headers, 300),
            UploadTicket(valid.url.replace("storage.yandexcloud.net", "storage.yandexcloud.net.evil.example"), valid.headers, 300),
            UploadTicket(valid.url.replace("/staging/", "/estimates/"), valid.headers, 300),
            UploadTicket(valid.url + "#fragment", valid.headers, 300),
            UploadTicket(valid.url.replace("content-length%3B", ""), valid.headers, 300),
            UploadTicket(valid.url, valid.headers + ("Authorization" to "must-not-send"), 300),
            UploadTicket(valid.url, valid.headers + ("Content-Length" to "1"), 300),
            UploadTicket(valid.url, valid.headers + ("Content-MD5" to "wrong"), 300),
            UploadTicket(valid.url, valid.headers + ("If-None-Match" to ""), 300)
        )
        variants.forEach { ticket ->
            var opened = false
            try {
                HttpsPdfNetwork { opened = true; Connection(200, byteArrayOf()) }.put(ticket, PdfFixtures.id, pdf)
                fail("Unsafe ticket was accepted")
            } catch (_: IllegalArgumentException) {}
            assertFalse(opened)
        }
    }

    @Test fun publicGetUsesCacheBusterAndChecksExactHashLengthAndMime() {
        val addresses = mutableListOf<String>()
        val c = Connection(200, pdf.bytes())
        val network = HttpsPdfNetwork { addresses += it.toString(); c }
        assertTrue(network.check(PdfFixtures.id, pdf).matches)
        assertTrue(network.check(PdfFixtures.id, pdf).matches)
        assertNotEquals(addresses[0], addresses[1])
        assertTrue(addresses[0].startsWith(Protocol.publicUrl(PdfFixtures.id) + "?kpro_check="))
        assertEquals("GET", c.requestMethod)
        assertTrue(c.getRequestProperty("Cache-Control").contains("no-store"))
        assertFalse(c.instanceFollowRedirects)
        val altered = pdf.bytes().also { it[it.lastIndex] = 0 }
        assertFalse(HttpsPdfNetwork { Connection(200, altered) }.check(PdfFixtures.id, pdf).matches)
        assertFalse(HttpsPdfNetwork { Connection(200, pdf.bytes() + 0.toByte()) }.check(PdfFixtures.id, pdf).matches)
        assertFalse(HttpsPdfNetwork { Connection(200, pdf.bytes(), mime = "text/html") }.check(PdfFixtures.id, pdf).matches)
    }

    @Test fun only403And404ProveUnavailability() {
        for (status in listOf(200, 301, 307, 401, 403, 404, 429, 500, 503)) {
            val result = HttpsPdfNetwork { Connection(status, byteArrayOf()) }.check(PdfFixtures.id, pdf)
            assertEquals(status == 403 || status == 404, result.unavailable)
        }
    }
}
