package ru.kuzovpro.gatewaytest

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class DeviceKey(private val alias: String = "kuzovpro-gateway-test-p256-v1") {
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    @Synchronized
    private fun entry(): KeyStore.PrivateKeyEntry {
        val ks = store()
        (ks.getEntry(alias, null) as? KeyStore.PrivateKeyEntry)?.let { return it }
        KeyPairGenerator.getInstance("EC", "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false).build())
            generateKeyPair()
        }
        return ks.getEntry(alias, null) as KeyStore.PrivateKeyEntry
    }
    fun publicKeyBase64(): String = Base64.getEncoder().encodeToString(entry().certificate.publicKey.encoded)
    fun sign(message: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(entry().privateKey)
        update(message)
        sign()
    }
    @Synchronized
    fun delete() { store().deleteEntry(alias) }
}
