package ru.kuzovpro.gatewaytest

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class ProtocolTest {
    private val time = 1_794_326_400L
    private val nonce = ByteArray(16) { it.toByte() }
    private fun pair() = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1")); generateKeyPair()
    }

    @Test fun syntheticMetadataMatchesActualBytes() {
        val body = JSONObject(String(Protocol.beginBody(), Charsets.UTF_8))
        val synthetic = "KuzovPRO gateway synthetic auth test v1\n".toByteArray(Charsets.UTF_8)
        assertEquals("begin", body.getString("operation"))
        assertEquals(synthetic.size, body.getInt("bytes"))
        assertTrue(synthetic.size in 20..10 * 1024 * 1024)
        assertEquals(Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(synthetic)),
            body.getString("md5_base64"))
        assertEquals(3, body.length())
    }

    @Test fun canonicalHasExactlyTwoNewlinesAndLowercaseSha256() {
        assertEquals("1794326400\n000102030405060708090a0b0c0d0e0f\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            String(Protocol.canonical("abc".toByteArray(), time.toString(), Protocol.hex(nonce)), Charsets.UTF_8))
    }

    @Test fun signedRequestUsesDerEcdsaAndDefensiveCopies() {
        val pair = pair()
        val body = Protocol.beginBody()
        var calls = 0
        val request = Protocol.signed(body, "test_device", {
            calls++
            Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(it); sign() }
        }, time, nonce)
        val original = request.bodyBytes()
        body.fill(0)
        request.bodyBytes().fill(0)
        val headers = request.signatureHeaders()
        val signature = Base64.getDecoder().decode(headers.getValue("x-kpro-signature"))
        assertEquals(0x30, signature[0].toInt()) // ASN.1 DER sequence, not P1363 r||s.
        val canonical = Protocol.canonical(original, headers.getValue("x-kpro-time"), headers.getValue("x-kpro-nonce"))
        fun verifies(bytes: ByteArray) = Signature.getInstance("SHA256withECDSA").run {
            initVerify(pair.public); update(bytes); verify(signature)
        }
        assertTrue(verifies(canonical))
        assertFalse(verifies(canonical + 32.toByte()))
        repeat(3) {
            assertArrayEquals(original, request.bodyBytes())
            assertTrue("Replay headers changed", headers == request.signatureHeaders())
        }
        assertEquals(1, calls)
        assertFalse(request.toString().contains(headers.getValue("x-kpro-signature")))
    }

    @Test fun revokeValidatesIdAndGetsNewNonce() {
        val id = "a".repeat(32)
        assertEquals("{\"operation\":\"revoke\",\"id\":\"$id\"}", String(Protocol.revokeBody(id)))
        val one = Protocol.signed(Protocol.revokeBody(id), "test", { byteArrayOf(48, 1) })
        val two = Protocol.signed(Protocol.revokeBody(id), "test", { byteArrayOf(48, 1) })
        assertNotEquals(one.signatureHeaders().getValue("x-kpro-nonce"), two.signatureHeaders().getValue("x-kpro-nonce"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun invalidIdCannotEnterJson() { Protocol.revokeBody("\"https://example.com\"") }

    @Test fun actualIndexJsAcceptsJvmSignatureAndRejectsMutations() {
        val pair = pair()
        val request = Protocol.signed(Protocol.beginBody(), "test_interop", {
            Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(it); sign() }
        }, time, nonce)
        val fixture = JSONObject()
            .put("time", time)
            .put("body", String(request.bodyBytes(), Charsets.UTF_8))
            .put("headers", JSONObject(request.signatureHeaders()))
            .put("publicKey", Base64.getEncoder().encodeToString(pair.public.encoded))
        // Synthetic one-use key/signature only; stdin, never test logs or report files.
        val process = ProcessBuilder("node", System.getProperty("gateway.auth.checker")).start()
        process.outputStream.bufferedWriter().use { it.write(fixture.toString()) }
        assertTrue("Node protocol checker timed out", process.waitFor(20, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals("Actual index.js auth interoperability failed", 0, process.exitValue())
    }
}
