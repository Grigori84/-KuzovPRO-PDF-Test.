package ru.kuzovpro.gatewaytest

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.SocketTimeoutException

class PdfCycleTest {
    private class Disk : CycleDisk {
        var raw: String? = null
        var fail = false
        override fun load() = raw?.let(CycleJson::decode)
        override fun save(state: CycleState) { if (fail) throw java.io.IOException(); raw = CycleJson.encode(state) }
    }
    private class Server(private val disk: Disk) : GatewayApi, PdfNetwork {
        val operations = mutableListOf<String>()
        var lost: String? = null
        var beginError: String? = null
        var putStatus = 200
        var publicStatus = 200
        var wrongPdf = false
        var failCheck = false
        var publishingConflict = false
        var newNonceCount = 0
        override fun post(request: GatewayRequest): GatewayResponse {
            val json = JSONObject(String(request.bodyBytes()))
            val op = json.getString("operation")
            operations += op
            assertTrue("Network occurred before durable pending state", disk.load()!!.phase.name.endsWith("PENDING") || op == "publish")
            if (lost == op) { lost = null; throw SocketTimeoutException() }
            return when (op) {
                "begin" -> if (beginError != null) GatewayResponse(503, beginError, null, false)
                    else GatewayResponse(200, null, PdfFixtures.id, false, PdfFixtures.ticket(disk.load()!!.pdf!!))
                "publish" -> {
                    assertEquals(PdfFixtures.id, json.getString("id"))
                    assertEquals(disk.load()!!.pdf!!.sha256, json.getString("sha256"))
                    if (publishingConflict) GatewayResponse(409, "PUBLICATION_IN_PROGRESS", null, false)
                    else GatewayResponse(200, null, PdfFixtures.id, false, viewerUrl = Protocol.viewerUrl(PdfFixtures.id))
                }
                else -> GatewayResponse(200, null, PdfFixtures.id, true).also { publicStatus = 404 }
            }
        }
        override fun put(ticket: UploadTicket, id: String, pdf: PdfPayload): PutResult {
            assertEquals(CyclePhase.PUT_PENDING, disk.load()!!.phase)
            assertEquals(id, disk.load()!!.id)
            assertArrayEquals(pdf.bytes(), disk.load()!!.pdf!!.bytes())
            operations += "PUT"
            if (lost == "PUT") { lost = null; throw SocketTimeoutException() }
            return PutResult(putStatus, putStatus == 200)
        }
        override fun check(id: String, pdf: PdfPayload?): DocumentCheck {
            if (failCheck) throw SocketTimeoutException()
            return DocumentCheck(publicStatus, publicStatus == 200 && !wrongPdf)
        }
        fun cycle() = PdfCycle(disk, this, this, {
            newNonceCount++
            Protocol.signed(it, "test", { byteArrayOf(48, 1) })
        })
    }
    private fun setup(): Triple<Disk, Server, PdfCycle> {
        val disk = Disk(); val server = Server(disk); val cycle = server.cycle()
        cycle.prepare(PdfFixtures.onePage())
        return Triple(disk, server, cycle)
    }

    @Test fun fullCyclePersistsOriginalBytesAndPreventsDoubleStart() {
        val (disk, server, cycle) = setup()
        cycle.fullCycle(); cycle.fullCycle(); cycle.begin()
        assertEquals(listOf("begin", "PUT", "publish"), server.operations)
        assertEquals(CyclePhase.PUBLISHED, disk.load()!!.phase)
        assertTrue(cycle.state.availableVerified)
        assertArrayEquals(PdfFixtures.onePage(), server.cycle().state.pdf!!.bytes())
        assertFalse(server.cycle().canBegin)
        cycle.revoke()
        assertTrue(server.cycle().state.unavailableVerified)
        assertTrue(cycle.canPrepare)
    }

    @Test fun lostBeginBlocksAnotherIdEvenAfterRestart() {
        val (disk, server, cycle) = setup(); server.lost = "begin"
        cycle.fullCycle()
        val restarted = server.cycle()
        restarted.fullCycle(); restarted.begin(); restarted.prepare(PdfFixtures.onePage())
        assertEquals(CyclePhase.BEGIN_UNKNOWN, disk.load()!!.phase)
        assertEquals(listOf("begin"), server.operations)
        assertFalse(restarted.canDeleteKey)
    }

    @Test fun disabledBeginCanBeRetriedButGeneric503RemainsUnknown() {
        val (_, server, cycle) = setup()
        server.beginError = "GATEWAY_DISABLED"; cycle.begin()
        assertTrue(cycle.canBegin)
        server.beginError = "GATEWAY_UNAVAILABLE"; cycle.begin()
        assertFalse(cycle.canBegin)
        assertEquals(CyclePhase.BEGIN_UNKNOWN, server.cycle().state.phase)
    }

    @Test fun lostPutResponseContinuesOnlyWithSameIdAndImmutablePdf() {
        val (_, server, cycle) = setup(); server.lost = "PUT"
        cycle.fullCycle()
        val restarted = server.cycle()
        assertEquals(CyclePhase.UPLOAD_UNKNOWN, restarted.state.phase)
        assertFalse(restarted.canPut) // URL was never stored on disk.
        restarted.publish()
        assertEquals(listOf("begin", "PUT", "publish"), server.operations)
        assertEquals(CyclePhase.PUBLISHED, restarted.state.phase)
    }

    @Test fun conditionalPutConflictDoesNotOverwriteOrAutoPublish() {
        val (_, server, cycle) = setup(); server.putStatus = 412
        cycle.fullCycle()
        assertEquals(listOf("begin", "PUT"), server.operations)
        assertEquals(CyclePhase.UPLOAD_UNKNOWN, cycle.state.phase)
        cycle.publish()
        assertEquals(PdfFixtures.id, cycle.state.id)
    }

    @Test fun lostPublishResponseAndServerBusyKeepSameId() {
        val (_, server, cycle) = setup(); server.lost = "publish"
        cycle.fullCycle()
        val restarted = server.cycle()
        server.publishingConflict = true; restarted.publish()
        assertEquals(CyclePhase.PUBLISH_UNKNOWN, restarted.state.phase)
        assertFalse(restarted.canBegin)
        server.publishingConflict = false; restarted.publish()
        assertEquals(CyclePhase.PUBLISHED, restarted.state.phase)
        assertEquals(1, server.operations.count { it == "begin" })
        assertEquals(1, server.operations.count { it == "PUT" })
    }

    @Test fun lostRevokeResponseNeverReenablesPublish() {
        val (_, server, cycle) = setup(); cycle.fullCycle(); server.lost = "revoke"
        cycle.revoke()
        val restarted = server.cycle()
        assertFalse(restarted.canPublish)
        restarted.publish()
        restarted.revoke()
        assertTrue(restarted.state.unavailableVerified)
        assertEquals(1, server.operations.count { it == "publish" })
    }

    @Test fun unavailableCheckDoesNotTreatNetwork500OrRedirectAsRevocationProof() {
        val (_, server, cycle) = setup(); cycle.fullCycle(); cycle.revoke()
        for (status in listOf(200, 302, 500)) {
            server.publicStatus = status; cycle.checkDocument()
            assertFalse(cycle.state.unavailableVerified)
            assertFalse(cycle.canPrepare)
        }
        server.failCheck = true; cycle.checkDocument()
        assertFalse(cycle.state.unavailableVerified)
        server.failCheck = false; server.publicStatus = 403; cycle.checkDocument()
        assertTrue(cycle.state.unavailableVerified)
    }

    @Test fun mismatchedDownloadedPdfIsNotVerified() {
        val (_, server, cycle) = setup(); server.wrongPdf = true
        cycle.fullCycle()
        assertEquals(CyclePhase.PUBLISHED, cycle.state.phase)
        assertFalse(cycle.state.availableVerified)
    }

    @Test fun pendingStatesRecoverAsUnknownWithoutAnyNetwork() {
        val pdf = PdfPayload(PdfFixtures.onePage())
        for ((pending, unknown) in mapOf(CyclePhase.BEGIN_PENDING to CyclePhase.BEGIN_UNKNOWN,
            CyclePhase.PUT_PENDING to CyclePhase.UPLOAD_UNKNOWN, CyclePhase.PUBLISH_PENDING to CyclePhase.PUBLISH_UNKNOWN,
            CyclePhase.REVOKE_PENDING to CyclePhase.REVOKE_UNKNOWN)) {
            val disk = Disk()
            disk.save(CycleState(pending, if (pending == CyclePhase.BEGIN_PENDING) null else PdfFixtures.id, pdf))
            val server = Server(disk); val recovered = server.cycle()
            assertEquals(unknown, recovered.state.phase)
            assertTrue(server.operations.isEmpty())
        }
    }

    @Test fun failedLocalWritePreventsNetworkAndKeepsIdInMemory() {
        val (disk, server, cycle) = setup(); disk.fail = true
        try { cycle.begin(); fail("Expected storage error") } catch (_: java.io.IOException) {}
        assertTrue(server.operations.isEmpty())
        assertTrue(cycle.storageFailed)
        assertFalse(cycle.canBegin)
    }

    @Test fun durableStateHasOnlyAllowlistedFieldsAndDetectsCorruption() {
        val (disk, _, cycle) = setup(); cycle.fullCycle()
        val obj = JSONObject(disk.raw!!)
        assertEquals(setOf("v", "phase", "id", "pdf_base64", "sha256", "bytes", "viewer_url",
            "publication_attempted", "available_verified", "unavailable_verified"), obj.keySet())
        assertFalse(disk.raw!!.contains("X-Amz"))
        assertFalse(disk.raw!!.contains("x-kpro"))
        obj.put("sha256", "0".repeat(64))
        try { CycleJson.decode(obj.toString()); fail("Corruption was accepted") } catch (_: IllegalArgumentException) {}
    }

    @Test fun failureToSaveReceivedIdStopsBeforePutAndStillShowsId() {
        val disk = Disk()
        val files = Server(disk)
        val api = object : GatewayApi {
            override fun post(request: GatewayRequest): GatewayResponse {
                disk.fail = true // begin already sent; saving its successful response now fails.
                return GatewayResponse(200, null, PdfFixtures.id, false, PdfFixtures.ticket(disk.load()!!.pdf!!))
            }
        }
        val cycle = PdfCycle(disk, api, files, { GatewayRequest(it) })
        cycle.prepare(PdfFixtures.onePage())
        try { cycle.fullCycle(); fail("Expected write failure") } catch (_: java.io.IOException) {}
        assertEquals(PdfFixtures.id, cycle.state.id)
        assertTrue(cycle.storageFailed)
        assertTrue(files.operations.isEmpty())
        assertFalse(cycle.canPut)
    }

    @Test fun expiredTicketCannotTriggerAutomaticNewBegin() {
        val disk = Disk(); val server = Server(disk); var now = 1000L
        val cycle = PdfCycle(disk, server, server, { GatewayRequest(it) }, nowMillis = { now })
        cycle.prepare(PdfFixtures.onePage()); cycle.begin()
        assertTrue(cycle.canPut)
        now += 301_000
        cycle.upload(); cycle.fullCycle()
        assertEquals(listOf("begin"), server.operations)
        assertFalse(cycle.canBegin)
        assertFalse(cycle.canPut)
        assertTrue(cycle.canPublish)
    }

    @Test fun expiredReplayOfUnknownBeginDoesNotPermitNewBegin() {
        val (_, server, cycle) = setup(); server.lost = "begin"; cycle.begin()
        // Replace the API with an explicit 401 result on replay without changing the saved pending outcome.
        val disk = Disk(); var calls = 0
        val api = object : GatewayApi {
            override fun post(request: GatewayRequest): GatewayResponse {
                calls++
                if (calls == 1) throw SocketTimeoutException()
                return GatewayResponse(401, "UNAUTHORIZED", null, false)
            }
        }
        val unknown = PdfCycle(disk, api, server, { GatewayRequest(it) })
        unknown.prepare(PdfFixtures.onePage()); unknown.begin(); unknown.replay()
        assertEquals(CyclePhase.BEGIN_UNKNOWN, unknown.state.phase)
        assertFalse(unknown.canBegin)
    }

    @Test fun replayAfterExplicitRejectedBeginCanSafelyReceiveAnId() {
        val disk = Disk(); val files = Server(disk); var calls = 0
        val api = object : GatewayApi {
            override fun post(request: GatewayRequest): GatewayResponse {
                calls++
                return if (calls == 1) GatewayResponse(503, "GATEWAY_DISABLED", null, false)
                else GatewayResponse(200, null, PdfFixtures.id, false, PdfFixtures.ticket(disk.load()!!.pdf!!))
            }
        }
        val cycle = PdfCycle(disk, api, files, { GatewayRequest(it) })
        cycle.prepare(PdfFixtures.onePage()); cycle.begin(); cycle.replay()
        assertEquals(CyclePhase.ISSUED, disk.load()!!.phase)
        assertEquals(PdfFixtures.id, disk.load()!!.id)
    }
}
