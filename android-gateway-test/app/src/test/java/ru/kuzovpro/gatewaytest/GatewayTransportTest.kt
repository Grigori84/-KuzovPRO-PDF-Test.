package ru.kuzovpro.gatewaytest

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

class GatewayTransportTest {
    private class FakeConnection(val status: Int, private val response: String, private val failReading: Boolean = false) : HttpURLConnection(URL(Protocol.ENDPOINT)) {
        val sent = ByteArrayOutputStream()
        var disconnected = false
        override fun getOutputStream() = sent
        override fun getInputStream(): java.io.InputStream {
            if (failReading) return object : java.io.InputStream() {
                override fun read(): Int = throw java.net.SocketTimeoutException()
            }
            return ByteArrayInputStream(response.toByteArray())
        }
        override fun getErrorStream() = inputStream
        override fun getResponseCode() = status
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun connect() {}
    }

    @Test fun replaySendsIdenticalBytesAndHeadersWithoutSigningAgain() {
        val connections = mutableListOf<FakeConnection>()
        val transport = GatewayTransport { url ->
            assertEquals(Protocol.ENDPOINT, url.toString())
            FakeConnection(409, "{\"error\":\"REPLAYED_REQUEST\"}").also { connections += it }
        }
        var signs = 0
        val request = Protocol.signed(Protocol.beginBody(), "test", { signs++; byteArrayOf(48, 1) })
        val first = transport.post(request)
        transport.post(request)
        assertEquals(1, signs)
        assertEquals(409, first.status)
        assertEquals("REPLAYED_REQUEST", first.error)
        assertArrayEquals(connections[0].sent.toByteArray(), connections[1].sent.toByteArray())
        assertTrue("Replay headers changed", connections[0].requestProperties == connections[1].requestProperties)
        connections.forEach {
            assertFalse(it.instanceFollowRedirects)
            assertEquals("POST", it.requestMethod)
            assertTrue(it.disconnected)
        }
    }

    @Test fun redirectIsReportedWithoutReadingLocationOrResponse() {
        val connection = FakeConnection(307, "https://secret.example/?token=not-for-output")
        val response = GatewayTransport { connection }.post(GatewayRequest(Protocol.beginBody()))
        assertEquals(307, response.status)
        assertNull(response.id)
        assertFalse(response.description().contains("secret"))
        assertFalse(connection.instanceFollowRedirects)
    }

    @Test fun beginResponseOnlyExposesValidIdAndNeverUploadUrl() {
        val id = "a".repeat(32)
        val response = GatewayTransport { FakeConnection(200,
            "{\"id\":\"$id\",\"upload_url\":\"https://example.com/?secret=temporary\",\"headers\":{}}") }
            .post(GatewayRequest(Protocol.beginBody()))
        assertEquals(id, response.id)
        assertNull(response.error)
        assertFalse(response.toString().contains("temporary"))
        assertFalse(response.description().contains("temporary"))
    }

    @Test fun errorCodeIsWhitelistedAndHtmlOrMalformedSuccessIsRejected() {
        for (body in listOf("<html>proxy issue</html>", "{\"error\":\"https://secret/?token=abc\"}", "{}")) {
            val response = GatewayTransport { FakeConnection(200, body) }.post(GatewayRequest(Protocol.beginBody()))
            assertEquals("INVALID_RESPONSE", response.error)
            assertEquals(200, response.status)
            assertFalse(response.description().contains("token"))
        }
        val unauthorized = GatewayTransport { FakeConnection(401, "{\"error\":\"UNAUTHORIZED\"}") }
            .post(GatewayRequest(Protocol.beginBody()))
        assertEquals("UNAUTHORIZED", unauthorized.error)
    }

    @Test fun responseIsSizeLimitedAndRevokeRequiresBoolean() {
        val large = GatewayTransport { FakeConnection(200, "x".repeat(17000)) }.post(GatewayRequest(Protocol.beginBody()))
        assertEquals("RESPONSE_TOO_LARGE", large.error)
        val id = "a".repeat(32)
        val result = GatewayTransport { FakeConnection(200, "{\"id\":\"$id\",\"revoked\":\"true\"}") }
            .post(GatewayRequest(Protocol.revokeBody(id)))
        assertFalse(result.revoked)
    }

    @Test fun interruptedResponseRetainsHttpStatusAndReportsUncertainty() {
        val connection = FakeConnection(200, "", failReading = true)
        val result = GatewayTransport { connection }.post(GatewayRequest(Protocol.beginBody()))
        assertEquals(200, result.status)
        assertEquals("RESPONSE_READ_FAILED", result.error)
        assertTrue(connection.disconnected)
    }

    @Test(expected = java.net.UnknownHostException::class)
    fun dnsFailureDoesNotBecomeFalseHttpSuccess() {
        GatewayTransport { throw java.net.UnknownHostException() }.post(GatewayRequest(Protocol.beginBody()))
    }
}
