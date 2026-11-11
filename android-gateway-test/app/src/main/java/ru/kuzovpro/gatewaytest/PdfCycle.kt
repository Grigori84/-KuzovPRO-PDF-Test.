package ru.kuzovpro.gatewaytest

import java.util.Base64
import org.json.JSONObject

class PdfPayload(bytes: ByteArray) {
    private val content = bytes.copyOf()
    val size = content.size
    val sha256 = Protocol.sha256(content)
    val md5 = Protocol.md5(content)
    init {
        require(size in 20..10 * 1024 * 1024 && String(content.copyOfRange(0, 5), Charsets.US_ASCII) == "%PDF-")
    }
    fun bytes() = content.copyOf()
    override fun toString() = "PdfPayload($size bytes)"
}

enum class CyclePhase {
    EMPTY, READY, BEGIN_PENDING, BEGIN_UNKNOWN, ISSUED, PUT_PENDING, UPLOAD_UNKNOWN,
    UPLOADED, PUBLISH_PENDING, PUBLISH_UNKNOWN, PUBLISHED, REVOKE_PENDING, REVOKE_UNKNOWN, REVOKED
}

data class CycleState(
    val phase: CyclePhase = CyclePhase.EMPTY,
    val id: String? = null,
    val pdf: PdfPayload? = null,
    val viewerUrl: String? = null,
    val publicationAttempted: Boolean = false,
    val availableVerified: Boolean = false,
    val unavailableVerified: Boolean = false
)

interface CycleDisk {
    fun load(): CycleState?
    fun save(state: CycleState)
}

object CycleJson {
    // Explicit allowlist: no signed request, upload ticket, nonce or temporary URL.
    fun encode(state: CycleState): String = JSONObject().apply {
        put("v", 2); put("phase", state.phase.name)
        state.id?.let { put("id", it) }
        state.pdf?.let {
            put("pdf_base64", Base64.getEncoder().encodeToString(it.bytes()))
            put("sha256", it.sha256); put("bytes", it.size)
        }
        state.viewerUrl?.let { put("viewer_url", it) }
        put("publication_attempted", state.publicationAttempted)
        put("available_verified", state.availableVerified)
        put("unavailable_verified", state.unavailableVerified)
    }.toString()

    fun decode(raw: String): CycleState {
        val json = JSONObject(raw)
        require(json.getInt("v") == 2)
        val phase = CyclePhase.valueOf(json.getString("phase"))
        val id = json.optString("id").takeIf { it.isNotEmpty() }
        require(id == null || Protocol.idPattern.matches(id))
        val pdf = if (json.has("pdf_base64")) PdfPayload(Base64.getDecoder().decode(json.getString("pdf_base64"))).also {
            require(it.sha256 == json.getString("sha256") && it.size == json.getInt("bytes"))
        } else null
        val viewer = json.optString("viewer_url").takeIf { it.isNotEmpty() }
        require(viewer == null || (id != null && viewer == Protocol.viewerUrl(id)))
        if (phase in setOf(CyclePhase.EMPTY, CyclePhase.READY, CyclePhase.BEGIN_PENDING, CyclePhase.BEGIN_UNKNOWN)) require(id == null)
        else require(id != null)
        if (phase in setOf(CyclePhase.READY, CyclePhase.BEGIN_PENDING, CyclePhase.BEGIN_UNKNOWN,
                CyclePhase.PUT_PENDING, CyclePhase.UPLOAD_UNKNOWN, CyclePhase.UPLOADED,
                CyclePhase.PUBLISH_PENDING, CyclePhase.PUBLISH_UNKNOWN, CyclePhase.PUBLISHED)) require(pdf != null)
        if (phase == CyclePhase.PUBLISHED) require(viewer != null)
        return CycleState(phase, id, pdf, viewer, json.getBoolean("publication_attempted"),
            json.getBoolean("available_verified"), json.getBoolean("unavailable_verified"))
    }
}

class PdfCycle(private val disk: CycleDisk, private val api: GatewayApi, private val files: PdfNetwork,
               private val sign: (ByteArray) -> GatewayRequest, private val nowMillis: () -> Long = System::currentTimeMillis,
               private val onProgress: () -> Unit = {}) {
    var state: CycleState = disk.load() ?: CycleState(); private set
    var storageFailed = false; private set
    var message = "Тестовый шлюз сейчас отключён. Подготовка PDF выполняется локально."; private set
    private var ticket: UploadTicket? = null
    private var ticketUntil = 0L
    private var replayRequest: GatewayRequest? = null
    private var replayOperation: String? = null
    private var replayTarget: String? = null
    val canReplay get() = !storageFailed && replayRequest != null
    val canPrepare get() = !storageFailed && (state.phase in setOf(CyclePhase.EMPTY, CyclePhase.READY) ||
        (state.phase == CyclePhase.REVOKED && (!state.publicationAttempted || state.unavailableVerified)))
    val canBegin get() = !storageFailed && state.phase == CyclePhase.READY && state.pdf != null
    val canPut get() = !storageFailed && ticket != null && nowMillis() < ticketUntil &&
        state.phase in setOf(CyclePhase.ISSUED, CyclePhase.UPLOAD_UNKNOWN)
    val canPublish get() = !storageFailed && state.id != null && state.pdf != null && state.phase in setOf(
        CyclePhase.ISSUED, CyclePhase.UPLOAD_UNKNOWN, CyclePhase.UPLOADED, CyclePhase.PUBLISH_UNKNOWN, CyclePhase.PUBLISHED)
    val canRevoke get() = !storageFailed && state.id != null && state.phase != CyclePhase.REVOKED
    val canDeleteKey get() = !storageFailed && (state.phase in setOf(CyclePhase.EMPTY, CyclePhase.READY) ||
        (state.phase == CyclePhase.REVOKED && (!state.publicationAttempted || state.unavailableVerified)))

    init {
        val recovered = when (state.phase) {
            CyclePhase.BEGIN_PENDING -> CyclePhase.BEGIN_UNKNOWN
            CyclePhase.PUT_PENDING -> CyclePhase.UPLOAD_UNKNOWN
            CyclePhase.PUBLISH_PENDING -> CyclePhase.PUBLISH_UNKNOWN
            CyclePhase.REVOKE_PENDING -> CyclePhase.REVOKE_UNKNOWN
            else -> state.phase
        }
        if (recovered != state.phase) persist(state.copy(phase = recovered))
        if (state.phase == CyclePhase.BEGIN_UNKNOWN) message = unknownBegin()
        else if (state.id != null) message = "Восстановлен ID ${state.id}. Новый begin не выполняется. Временная PUT-ссылка не сохранялась."
    }

    @Synchronized fun prepare(bytes: ByteArray) {
        if (!canPrepare) return
        val pdf = PdfPayload(bytes)
        persist(CycleState(CyclePhase.READY, pdf = pdf))
        ticket = null
        replayRequest = null
        message = "Искусственный PDF сохранён: ${pdf.size} байт. Можно начать полный цикл после отдельного разрешения на включение шлюза."
    }

    @Synchronized fun fullCycle() {
        if (!canBegin) return
        begin()
        if (canPut) upload()
        if (state.phase == CyclePhase.UPLOADED) publish()
        if (state.phase == CyclePhase.PUBLISHED) checkDocument()
    }

    @Synchronized fun begin() {
        if (!canBegin) return
        val pdf = state.pdf ?: return
        persist(state.copy(phase = CyclePhase.BEGIN_PENDING)) // durable before network
        val response = request("begin", null, Protocol.beginBody(pdf.bytes()), CyclePhase.BEGIN_UNKNOWN) ?: return
        acceptBegin(response)
    }

    private fun acceptBegin(response: GatewayResponse, mayReset: Boolean = true) {
        message = response.description()
        if (response.status in 200..299 && response.error == null && response.id != null) {
            // Persist the issued ID BEFORE inspecting or using a signed URL.
            persist(state.copy(phase = CyclePhase.ISSUED, id = response.id))
            val candidate = response.ticket
            if (candidate != null) {
                try {
                    HttpsPdfNetwork.validateTicket(candidate, response.id, state.pdf!!)
                    ticket = candidate
                    ticketUntil = nowMillis() + candidate.expiresSeconds * 1000L
                } catch (_: Exception) { message += "\nPUT-ссылка или подписанные заголовки не прошли проверку. ID сохранён; доступен отзыв." }
            } else message += "\nОтвет без корректного билета PUT. ID сохранён; доступен отзыв."
            message += "\nID сохранён: ${response.id}."
        } else {
            val rejected = mayReset && ((response.status == 401 && response.error == "UNAUTHORIZED") ||
                (response.status == 503 && response.error == "GATEWAY_DISABLED") ||
                (response.status == 400 && response.error in setOf("INVALID_FILE_INFO", "INVALID_JSON", "UNKNOWN_OPERATION")) ||
                (response.status == 405 && response.error == "METHOD_NOT_ALLOWED") ||
                (response.status == 413 && response.error == "REQUEST_TOO_LARGE"))
            persist(state.copy(phase = if (rejected) CyclePhase.READY else CyclePhase.BEGIN_UNKNOWN))
            if (!rejected) message += "\n" + unknownBegin()
        }
    }

    @Synchronized fun upload() {
        if (!canPut) { message = "PUT-ссылка отсутствует или истекла. Новый begin не создаётся. Для того же ID можно проверить publish или выполнить отзыв."; return }
        val pdf = state.pdf ?: return
        val id = state.id ?: return
        val currentTicket = ticket ?: return
        persist(state.copy(phase = CyclePhase.PUT_PENDING))
        val result = try { files.put(currentTicket, id, pdf) }
            catch (error: Exception) {
                persist(state.copy(phase = CyclePhase.UPLOAD_UNKNOWN))
                message = connectionFailure(error) + "\nРезультат PUT неизвестен. Проверьте publish того же ID. Новый begin не создаётся."
                return
            }
        val confirmed = result.status in 200..299 && result.md5Confirmed
        persist(state.copy(phase = if (confirmed) CyclePhase.UPLOADED else CyclePhase.UPLOAD_UNKNOWN))
        message = "PUT · HTTP ${result.status}\n" + if (confirmed) "Загрузка подтверждена, ETag совпадает с MD5."
            else "Загрузка не подтверждена. При 409/412 объект мог уже сохраниться. Можно проверить publish того же ID; перезаписи нет."
    }

    @Synchronized fun publish() {
        if (!canPublish) return
        val pdf = state.pdf ?: return
        val id = state.id ?: return
        persist(state.copy(phase = CyclePhase.PUBLISH_PENDING, publicationAttempted = true, availableVerified = false))
        val response = request("publish", id, Protocol.publishBody(id, pdf.size, pdf.sha256), CyclePhase.PUBLISH_UNKNOWN) ?: return
        acceptPublish(response, id)
    }

    private fun acceptPublish(response: GatewayResponse, id: String) {
        message = response.description()
        if (response.status in 200..299 && response.error == null && response.id == id && response.viewerUrl == Protocol.viewerUrl(id)) {
            persist(state.copy(phase = CyclePhase.PUBLISHED, viewerUrl = response.viewerUrl))
            ticket = null
            message += "\nПубликация подтверждена. Ссылка PDF.js сохранена."
        } else {
            persist(state.copy(phase = CyclePhase.PUBLISH_UNKNOWN))
            message += "\nПубликация не подтверждена. Повтор publish использует прежний ID и PDF с тем же SHA-256."
        }
    }

    @Synchronized fun revoke() {
        if (!canRevoke) return
        val id = state.id ?: return
        persist(state.copy(phase = CyclePhase.REVOKE_PENDING, availableVerified = false))
        val response = request("revoke", id, Protocol.revokeBody(id), CyclePhase.REVOKE_UNKNOWN) ?: return
        acceptRevoke(response, id)
        if (state.phase == CyclePhase.REVOKED) {
            val confirmation = message
            checkDocument()
            message = confirmation + "\n" + message
        }
    }

    private fun acceptRevoke(response: GatewayResponse, id: String) {
        message = response.description()
        if (response.status in 200..299 && response.error == null && response.id == id && response.revoked) {
            persist(state.copy(phase = CyclePhase.REVOKED, unavailableVerified = false))
            ticket = null
            message += "\nОтзыв ID подтверждён сервером."
        } else {
            persist(state.copy(phase = CyclePhase.REVOKE_UNKNOWN))
            message += "\nОтзыв не подтверждён. Повторите revoke того же ID с новым nonce."
        }
    }

    @Synchronized fun checkDocument() {
        if (storageFailed) return
        val id = state.id ?: return
        val result = try { files.check(id, state.pdf) }
            catch (error: Exception) {
                persist(state.copy(availableVerified = false, unavailableVerified = false))
                message = connectionFailure(error) + "\nДоступность/недоступность документа не подтверждена."
                return
            }
        val available = state.phase == CyclePhase.PUBLISHED && result.matches
        val unavailable = state.phase == CyclePhase.REVOKED && result.unavailable
        persist(state.copy(availableVerified = available, unavailableVerified = unavailable))
        message = "Проверка PDF · HTTP ${result.status}\n" + when {
            unavailable -> "Документ недоступен по прямому адресу (без кэша). Отзыв и недоступность подтверждены."
            available -> "Скачанный PDF совпадает по размеру и SHA-256 с сохранённым оригиналом."
            state.phase == CyclePhase.REVOKED && result.status == 200 -> "ВНИМАНИЕ: после revoke сервер всё ещё отдаёт HTTP 200. Недоступность не подтверждена."
            else -> "Ожидаемый результат не подтверждён. HTTP 3xx, 5xx, ошибки сети и другой PDF не считаются успехом."
        }
    }

    @Synchronized fun replay() {
        if (!canReplay) return
        val request = replayRequest ?: return
        val op = replayOperation ?: return
        val target = replayTarget
        val beginsFromReady = op == "begin" && state.phase == CyclePhase.READY
        if (beginsFromReady) persist(state.copy(phase = CyclePhase.BEGIN_PENDING))
        val response = try { api.post(request) } catch (error: Exception) {
            if (beginsFromReady) persist(state.copy(phase = CyclePhase.BEGIN_UNKNOWN))
            message = connectionFailure(error) + "\nРезультат исходной операции не подтверждён."; return
        }
        // A replay cannot regress a later step or resurrect a revoked ID.
        if (op == "begin" && state.phase in setOf(CyclePhase.BEGIN_UNKNOWN, CyclePhase.BEGIN_PENDING)) acceptBegin(response, beginsFromReady)
        else if (op == "publish" && state.phase == CyclePhase.PUBLISH_UNKNOWN && target == state.id) acceptPublish(response, target!!)
        else if (op == "revoke" && state.phase == CyclePhase.REVOKE_UNKNOWN && target == state.id) acceptRevoke(response, target!!)
        else message = response.description() + "\nОтвет точного повтора; состояние публикации не изменено."
    }

    private fun request(operation: String, target: String?, body: ByteArray, unknown: CyclePhase): GatewayResponse? {
        return try {
            val request = sign(body)
            replayRequest = request
            replayOperation = operation
            replayTarget = target
            api.post(request)
        } catch (error: Exception) {
            persist(state.copy(phase = unknown))
            message = connectionFailure(error) + "\n" + if (unknown == CyclePhase.BEGIN_UNKNOWN) unknownBegin()
                else "Результат $operation неизвестен. Продолжайте только с прежним ID."
            null
        }
    }

    private fun persist(next: CycleState) {
        check(!storageFailed)
        state = next // Preserve a received ID in memory even if the durable write fails.
        try { disk.save(next) } catch (_: Exception) {
            storageFailed = true
            message = "Ошибка сохранения. Сетевые действия заблокированы; не удаляйте приложение. ID: ${next.id ?: "не получен"}."
            throw java.io.IOException("LOCAL_STATE_WRITE_FAILED")
        }
        onProgress()
    }

    private fun unknownBegin() = "Результат begin неизвестен. Новый begin заблокирован: сервер мог выдать ID. API не умеет искать потерянный ID; требуется проверка владельцем сервера по ID устройства."
}
