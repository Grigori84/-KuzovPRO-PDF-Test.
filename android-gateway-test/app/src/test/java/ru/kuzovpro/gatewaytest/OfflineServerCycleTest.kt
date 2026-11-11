package ru.kuzovpro.gatewaytest

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.File
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class OfflineServerCycleTest {
    private class Bridge : GatewayApi, PdfNetwork, Closeable {
        private val key = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp256r1")); generateKeyPair() }
        private val script = File(requireNotNull(System.getProperty("gateway.auth.checker"))).resolveSibling("offline-cycle.cjs")
        private val process = ProcessBuilder("node", script.absolutePath).start()
        private val writer = process.outputStream.bufferedWriter()
        private val reader = process.inputStream.bufferedReader()
        init { send(JSONObject().put("type", "init").put("device", "test_offline").put("publicKey", Base64.getEncoder().encodeToString(key.public.encoded))) }
        fun sign(body: ByteArray) = Protocol.signed(body, "test_offline", {
            Signature.getInstance("SHA256withECDSA").run { initSign(key.private); update(it); sign() }
        })
        fun send(input: JSONObject): JSONObject {
            writer.write(input.toString()); writer.newLine(); writer.flush()
            return JSONObject(reader.readLine() ?: throw java.io.IOException("OFFLINE_BRIDGE_CLOSED"))
        }
        override fun post(request: GatewayRequest): GatewayResponse {
            val response = send(JSONObject().put("type", "post").put("body", String(request.bodyBytes()))
                .put("headers", JSONObject(request.signatureHeaders())))
            if (response.optBoolean("lost")) throw java.net.SocketTimeoutException()
            val ticket = if (response.has("upload_url")) {
                val h = response.getJSONObject("headers")
                UploadTicket(response.getString("upload_url"), h.keys().asSequence().associateWith { h.getString(it) }, response.getInt("expires_seconds"))
            } else null
            return GatewayResponse(response.getInt("status"), response.optString("error").takeIf { it.isNotEmpty() },
                response.optString("id").takeIf { it.isNotEmpty() }, response.optBoolean("revoked"), ticket,
                response.optString("url").takeIf { it.isNotEmpty() })
        }
        override fun put(ticket: UploadTicket, id: String, pdf: PdfPayload): PutResult {
            HttpsPdfNetwork.validateTicket(ticket, id, pdf)
            val r = send(JSONObject().put("type", "put").put("id", id).put("bytes", Base64.getEncoder().encodeToString(pdf.bytes())))
            return PutResult(r.getInt("status"), r.getBoolean("md5"))
        }
        override fun check(id: String, pdf: PdfPayload?): DocumentCheck {
            val r = send(JSONObject().put("type", "check").put("id", id))
            return DocumentCheck(r.getInt("status"), pdf != null && r.optString("sha256") == pdf.sha256 && r.optInt("bytes") == pdf.size)
        }
        override fun close() {
            writer.close()
            if (!process.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) process.destroyForcibly()
        }
    }
    private class Disk : CycleDisk {
        var raw: String? = null
        override fun load() = raw?.let(CycleJson::decode)
        override fun save(state: CycleState) { raw = CycleJson.encode(state) }
    }

    @Test(timeout = 30000) fun fullCycleUsesRealServerWorkflowPdfParserAndAuthOffline() {
        Bridge().use { bridge ->
            val disk = Disk()
            val cycle = PdfCycle(disk, bridge, bridge, bridge::sign)
            cycle.prepare(PdfFixtures.onePage()); cycle.fullCycle()
            assertEquals(CyclePhase.PUBLISHED, cycle.state.phase)
            assertTrue(cycle.state.availableVerified)
            assertEquals(Protocol.viewerUrl(PdfFixtures.id), cycle.state.viewerUrl)
            cycle.revoke()
            assertEquals(CyclePhase.REVOKED, cycle.state.phase)
            assertTrue(cycle.state.unavailableVerified)
        }
    }

    @Test(timeout = 30000) fun lostSuccessfulPublishResponseRecoversSameServerPublicationAfterRestart() {
        Bridge().use { bridge ->
            val disk = Disk()
            bridge.send(JSONObject().put("type", "drop-publish"))
            val cycle = PdfCycle(disk, bridge, bridge, bridge::sign)
            cycle.prepare(PdfFixtures.onePage()); cycle.fullCycle()
            assertEquals(CyclePhase.PUBLISH_UNKNOWN, cycle.state.phase)
            val restarted = PdfCycle(disk, bridge, bridge, bridge::sign)
            restarted.fullCycle() // Must do nothing; never begin a second publication.
            restarted.publish(); restarted.checkDocument()
            assertEquals(CyclePhase.PUBLISHED, restarted.state.phase)
            assertTrue(restarted.state.availableVerified)
            val operations = bridge.send(JSONObject().put("type", "stats")).getJSONArray("operations")
            assertEquals(listOf("begin", "PUT", "publish", "publish"), (0 until operations.length()).map { operations.getString(it) })
            restarted.revoke(); assertTrue(restarted.state.unavailableVerified)
        }
    }
}
