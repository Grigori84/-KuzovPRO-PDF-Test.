package ru.kuzovpro.gatewaytest

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.UUID
import java.util.concurrent.Executors

class GatewayTestApp : Application() {
    lateinit var session: TestSession
        private set
    override fun onCreate() {
        super.onCreate()
        session = TestSession(this)
    }
}

// One process-wide worker: double taps and rotation cannot start concurrent publications.
class TestSession(context: Context) {
    private val prefs = context.getSharedPreferences("gateway-test", Context.MODE_PRIVATE)
    private val disk = AndroidCycleDisk(context)
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val key = DeviceKey()
    private val transport = GatewayTransport()
    private var cycle: PdfCycle? = null
    var listener: (() -> Unit)? = null
    var busy = false; private set
    var publicKey: String? = null; private set
    var deviceId: String = prefs.getString("device", "") ?: ""; private set
    var status = "Чтение сохранённого состояния…"; private set
    val state: CycleState? get() = cycle?.state
    val canPrepare get() = cycle?.canPrepare == true
    val canBegin get() = publicKey != null && cycle?.canBegin == true
    val canPut get() = publicKey != null && cycle?.canPut == true
    val canPublish get() = publicKey != null && cycle?.canPublish == true
    val canRevoke get() = publicKey != null && cycle?.canRevoke == true
    val canReplay get() = publicKey != null && cycle?.canReplay == true
    val canDeleteKey get() = publicKey != null && cycle?.canDeleteKey == true
    val viewerUrl get() = state?.takeIf { it.phase == CyclePhase.PUBLISHED }?.viewerUrl

    init {
        work {
            // v0.1 IDs migrate without pretending its synthetic non-PDF bytes can be published.
            if (disk.load() == null) {
                val oldId = prefs.getString("issued_id", null)?.takeIf { Protocol.idPattern.matches(it) }
                if (oldId != null) {
                    disk.save(CycleState(if (prefs.getBoolean("revoked", false)) CyclePhase.REVOKED else CyclePhase.ISSUED, id = oldId))
                    check(prefs.edit().remove("issued_id").remove("revoked").commit())
                }
            }
            cycle = newCycle()
            if (!prefs.getBoolean("key_deleted", false)) loadKey()
            status = cycle!!.message + if (prefs.getBoolean("key_deleted", false)) "\nТестовый ключ удалён. Создайте новый только для нового испытания." else ""
        }
    }

    private fun newCycle() = PdfCycle(disk, transport, HttpsPdfNetwork(), {
        Protocol.signed(it, deviceId, key::sign)
    }, onProgress = { main.post { listener?.invoke() } })

    private fun loadKey() {
        if (deviceId.isEmpty() || prefs.getBoolean("key_deleted", false)) {
            val newId = "test_" + UUID.randomUUID().toString().replace("-", "")
            check(prefs.edit().putString("device", newId).putBoolean("key_deleted", false).commit())
            deviceId = newId
        }
        publicKey = key.publicKeyBase64()
    }

    fun createKey() = work {
        if (cycle == null || cycle?.canDeleteKey != true) return@work
        loadKey()
        status = "Ключ готов. Зарегистрируйте ID устройства и публичный ключ перед подписанным тестом."
    }

    fun preparePdf() = action { it.prepare(SyntheticPdf.create()) }
    fun fullCycle() = action { if (publicKey != null) it.fullCycle() }
    fun begin() = action { if (publicKey != null) it.begin() }
    fun upload() = action { if (publicKey != null) it.upload() }
    fun publish() = action { if (publicKey != null) { it.publish(); if (it.state.phase == CyclePhase.PUBLISHED) it.checkDocument() } }
    fun revoke() = action { if (publicKey != null) it.revoke() }
    fun replay() = action { if (publicKey != null) it.replay() }
    fun checkDocument() = action { it.checkDocument() }
    private fun action(block: (PdfCycle) -> Unit) = work {
        val active = cycle ?: return@work
        block(active)
        status = active.message
    }

    fun unsigned() = work {
        val body = state?.pdf?.let { Protocol.beginBody(it.bytes()) } ?: Protocol.beginBody()
        status = transport.post(GatewayRequest(body)).description()
    }

    fun deleteKey() = work {
        if (!canDeleteKey) return@work
        check(prefs.edit().putBoolean("key_deleted", true).commit())
        key.delete()
        publicKey = null
        deviceId = ""
        check(prefs.edit().remove("device").commit())
        cycle = newCycle()
        status = "Тестовый ключ удалён. Удалите регистрацию устройства на сервере. Сохранённый PDF и подтверждённое состояние оставлены для проверки."
    }

    fun browserFailed() { status = "Не удалось открыть браузер. Установите или включите Samsung Internet либо другой браузер."; listener?.invoke() }

    private fun work(block: () -> Unit) {
        if (busy) return
        busy = true
        listener?.invoke()
        executor.execute {
            try { block() }
            catch (error: Exception) {
                status = if (cycle?.storageFailed == true) cycle!!.message
                    else if (cycle == null) "Не удалось прочитать сохранённый цикл или инициализировать ключ. Сетевые действия цикла заблокированы; данные не удалены."
                    else connectionFailure(error) + "\nДанные не сброшены. Проверьте сохранённый этап; новая публикация автоматически не создаётся."
            }
            // No exception messages or stack traces: they may contain signed URLs.
            main.post { busy = false; listener?.invoke() }
        }
    }
}
