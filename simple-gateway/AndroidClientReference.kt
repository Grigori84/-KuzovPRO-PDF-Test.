package ru.kuzovpro.pdfgateway.prototype

// REFERENCE ONLY: not integrated into KuzovPRO. Network calls require Dispatchers.IO.
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.*
import java.security.spec.ECGenParameterSpec

class PdfGatewayClient(private val endpoint: String, private val deviceId: String) {
    private val alias = "kpro-pdf-gateway-v1"
    private val random = SecureRandom()
    init {
        require(endpoint.startsWith("https://"))
        require(deviceId.matches(Regex("[A-Za-z0-9_-]{1,40}")))
    }

    private fun deviceKey(): KeyStore.PrivateKeyEntry {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val found = ks.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        if (found != null) return found
        val generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore")
        generator.initialize(KeyGenParameterSpec.Builder(
            alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false).build())
        generator.generateKeyPair()
        return ks.getEntry(alias, null) as KeyStore.PrivateKeyEntry
    }

    // Copy this non-secret value into DEVICE_PUBLIC_KEYS_JSON once.
    fun publicKeyBase64(): String =
        Base64.encodeToString(deviceKey().certificate.publicKey.encoded, Base64.NO_WRAP)

    private fun hash(algorithm: String, bytes: ByteArray): ByteArray =
        MessageDigest.getInstance(algorithm).digest(bytes)

    private fun hex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

    private fun post(json: JSONObject): JSONObject {
        val raw = json.toString().toByteArray(StandardCharsets.UTF_8)
        val now = (System.currentTimeMillis() / 1000L).toString()
        val nonce = hex(ByteArray(16).also { random.nextBytes(it) })
        val canonical = now + "\n" + nonce + "\n" + hex(hash("SHA-256", raw))
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(deviceKey().privateKey)
        signer.update(canonical.toByteArray(StandardCharsets.UTF_8))
        val signature = Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
        val c = URL(endpoint).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.doOutput = true
        c.connectTimeout = 15000
        c.readTimeout = 90000
        c.setRequestProperty("Content-Type", "application/json")
        c.setRequestProperty("x-kpro-device", deviceId)
        c.setRequestProperty("x-kpro-time", now)
        c.setRequestProperty("x-kpro-nonce", nonce)
        c.setRequestProperty("x-kpro-signature", signature)
        c.setFixedLengthStreamingMode(raw.size)
        try {
            c.outputStream.use { it.write(raw) }
            val status = c.responseCode
            val stream = if (status in 200..299) c.inputStream else c.errorStream
            val result = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (status !in 200..299) throw IllegalStateException(
                "PDF gateway: HTTP " + status + " " + result.take(200))
            return JSONObject(result)
        } finally { c.disconnect() }
    }

    private fun directPut(url: String, headers: JSONObject, pdf: ByteArray) {
        require(url.startsWith("https://storage.yandexcloud.net/"))
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = "PUT"
        c.doOutput = true
        c.connectTimeout = 15000
        c.readTimeout = 120000
        for (name in headers.keys()) c.setRequestProperty(name, headers.getString(name))
        c.setFixedLengthStreamingMode(pdf.size)
        try {
            c.outputStream.use { it.write(pdf) }
            if (c.responseCode !in 200..299)
                throw IllegalStateException("PDF upload: HTTP " + c.responseCode)
        } finally { c.disconnect() }
    }

    data class Publication(val id: String, val url: String)

    // Save Publication.id and the immutable estimate-version ID on success.
    // Do not send an SMS until this function RETURNS successfully.
    fun publish(pdf: ByteArray): Publication {
        require(pdf.size in 10..(10 * 1024 * 1024))
        require(String(pdf.copyOfRange(0, 5), StandardCharsets.US_ASCII) == "%PDF-")
        val md5 = Base64.encodeToString(hash("MD5", pdf), Base64.NO_WRAP)
        val sha = hex(hash("SHA-256", pdf))
        val ticket = post(JSONObject().put("operation", "begin")
            .put("bytes", pdf.size).put("md5_base64", md5))
        val id = ticket.getString("id")
        directPut(ticket.getString("upload_url"), ticket.getJSONObject("headers"), pdf)
        val final = post(JSONObject().put("operation", "publish")
            .put("id", id).put("bytes", pdf.size).put("sha256", sha))
        return Publication(id, final.getString("url"))
    }

    // Call when revoking a link or deleting its order; surface failures.
    fun revoke(id: String) {
        require(id.matches(Regex("[0-9a-f]{32}")))
        check(post(JSONObject().put("operation", "revoke")
            .put("id", id)).getBoolean("revoked"))
    }
}
