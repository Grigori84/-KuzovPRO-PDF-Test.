package ru.kuzovpro.gatewaytest

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyFactory
import java.security.KeyStore
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class DeviceKeyTest {
    @Test fun keystoreKeyIsNonExportableStableAndCanBeDeleted() {
        // Separate alias so this test never touches the app's registered test key.
        val alias = "gateway-instrumentation-" + UUID.randomUUID()
        val key = DeviceKey(alias)
        try {
            val publicKey = key.publicKeyBase64()
            assertEquals(publicKey, DeviceKey(alias).publicKeyBase64())
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val entry = store.getEntry(alias, null) as KeyStore.PrivateKeyEntry
            assertNull(entry.privateKey.encoded)
            val decoded = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(publicKey)))
            val body = Protocol.beginBody()
            val canonical = Protocol.canonical(body, "1794326400", "a".repeat(32))
            val signature = key.sign(canonical)
            assertTrue(Signature.getInstance("SHA256withECDSA").run {
                initVerify(decoded); update(canonical); verify(signature)
            })
            key.delete()
            assertFalse(store.containsAlias(alias))
            assertNotEquals(publicKey, key.publicKeyBase64())
        } finally { key.delete() }
    }
}
