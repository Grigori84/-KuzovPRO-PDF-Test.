package ru.kuzovpro.gatewaytest

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

object Protocol {
    const val ENDPOINT = "https://d5dfv1oa7vjlshd5ic71.4kscn31j.apigw.yandexcloud.net/pdf"
    val idPattern = Regex("[0-9a-f]{32}")
    private val devicePattern = Regex("[A-Za-z0-9_-]{1,40}")
    private const val SYNTHETIC = "KuzovPRO gateway synthetic auth test v1\n"

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    fun beginBody(): ByteArray {
        val bytes = SYNTHETIC.toByteArray(Charsets.UTF_8)
        val md5 = Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes))
        return "{\"operation\":\"begin\",\"bytes\":${bytes.size},\"md5_base64\":\"$md5\"}".toByteArray(Charsets.UTF_8)
    }
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
