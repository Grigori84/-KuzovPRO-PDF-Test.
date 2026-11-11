package ru.kuzovpro.gatewaytest

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

object Protocol {
    const val ENDPOINT = "https://d5dfv1oa7vjlshd5ic71.4kscn31j.apigw.yandexcloud.net/pdf"
    const val VIEWER = "https://grigori84.github.io/-KuzovPRO-PDF-Test./client.html"
    const val PUBLIC_STORAGE = "https://storage.yandexcloud.net/kuzovpro-pdf-test-84/estimates/"
    val idPattern = Regex("[0-9a-f]{32}")
    private val devicePattern = Regex("[A-Za-z0-9_-]{1,40}")
    private const val SYNTHETIC = "KuzovPRO gateway synthetic auth test v1\n"

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    fun beginBody(): ByteArray {
        return beginBody(SYNTHETIC.toByteArray(Charsets.UTF_8))
    }
    fun md5(bytes: ByteArray): String = Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes))
    fun beginBody(bytes: ByteArray): ByteArray {
        require(bytes.size in 20..10 * 1024 * 1024)
        val md5 = md5(bytes)
        return "{\"operation\":\"begin\",\"bytes\":${bytes.size},\"md5_base64\":\"$md5\"}".toByteArray(Charsets.UTF_8)
    }
    fun publishBody(id: String, bytes: Int, sha256: String): ByteArray {
        require(idPattern.matches(id) && bytes in 20..10 * 1024 * 1024 && Regex("[a-f0-9]{64}").matches(sha256))
        return "{\"operation\":\"publish\",\"id\":\"$id\",\"bytes\":$bytes,\"sha256\":\"$sha256\"}".toByteArray(Charsets.UTF_8)
    }
    fun viewerUrl(id: String): String { require(idPattern.matches(id)); return "$VIEWER#id=$id" }
    fun publicUrl(id: String): String { require(idPattern.matches(id)); return "$PUBLIC_STORAGE$id.pdf" }
    fun revokeBody(id: String): ByteArray {
        require(idPattern.matches(id))
        return "{\"operation\":\"revoke\",\"id\":\"$id\"}".toByteArray(Charsets.UTF_8)
    }
    fun canonical(body: ByteArray, time: String, nonce: String): ByteArray {
        require(Regex("[0-9]{10}").matches(time))
        require(idPattern.matches(nonce))
        return "$time\n$nonce\n${sha256(body)}".toByteArray(Charsets.UTF_8)
    }
    fun signed(body: ByteArray, device: String, sign: (ByteArray) -> ByteArray,
               seconds: Long = System.currentTimeMillis() / 1000,
               nonceBytes: ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) }): GatewayRequest {
        require(devicePattern.matches(device))
        require(nonceBytes.size == 16)
        val frozenBody = body.copyOf()
        val time = seconds.toString()
        val nonce = hex(nonceBytes)
        val signature = Base64.getEncoder().encodeToString(sign(canonical(frozenBody, time, nonce)))
        return GatewayRequest(frozenBody, mapOf(
            "x-kpro-device" to device, "x-kpro-time" to time,
            "x-kpro-nonce" to nonce, "x-kpro-signature" to signature
        ))
    }
}

// No data-class toString(): signatures and request material must never appear in logs.
class GatewayRequest(body: ByteArray, headers: Map<String, String> = emptyMap()) {
    private val body = body.copyOf()
    private val headers = headers.toMap()
    fun bodyBytes(): ByteArray = body.copyOf()
    fun signatureHeaders(): Map<String, String> = headers.toMap()
    override fun toString(): String = "GatewayRequest(redacted)"
}
