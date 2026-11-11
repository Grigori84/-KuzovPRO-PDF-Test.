package ru.kuzovpro.gatewaytest

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.Executors
import javax.net.ssl.SSLException

class GatewayTestApp : Application() {
    lateinit var session: TestSession
        private set
    override fun onCreate() {
        super.onCreate()
        session = TestSession(this)
    }
}

// Application lifetime: rotation never restarts a request. Replay lives only in memory.
class TestSession(context: Context) {
    private val prefs = context.getSharedPreferences("gateway-test", Context.MODE_PRIVATE)
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val key = DeviceKey()
    private val transport = GatewayTransport()
    private var lastRequest: GatewayRequest? = null
    private var lastOperation: String? = null
    private var lastTarget: String? = null
    var listener: (() -> Unit)? = null
    var busy = false; private set
    var publicKey: String? = null; private set
    var deviceId: String = prefs.getString("device", "") ?: ""; private set
    var issuedId: String? = prefs.getString("issued_id", null)?.takeIf { Protocol.idPattern.matches(it) }; private set
    var revoked = prefs.getBoolean("revoked", false); private set
    var status = "Подготовка тестового ключа…"; private set
    val canBegin: Boolean get() = publicKey != null && (issuedId == null || revoked)
    val canReplay: Boolean get() = lastRequest != null

    init {
        if (prefs.getBoolean("key_deleted", false)) {
            status = "Тестовый ключ удалён. Новый ключ создаётся только по кнопке."
        } else createKey()
    }

    fun createKey() = work {
        if (deviceId.isEmpty() || prefs.getBoolean("key_deleted", false)) {
            // Random test identity; never use IMEI, serial number or Android ID.
            val newId = "test_" + UUID.randomUUID().toString().replace("-", "")
            check(prefs.edit().putString("device", newId).putBoolean("key_deleted", false).commit())
            deviceId = newId
        }
        publicKey = key.publicKeyBase64()
        status = "Ключ готов. Зарегистрируйте ID устройства и публичный ключ на сервере перед подписанным тестом."
    }

    fun unsigned() = work {
        status = transport.post(GatewayRequest(Protocol.beginBody())).description()
    }

    fun begin() {
        if (!canBegin) return
        signed("begin", null, Protocol.beginBody())
    }

    fun revoke() {
        val id = issuedId ?: return
        if (publicKey == null || revoked) return
        signed("revoke", id, Protocol.revokeBody(id))
    }

    private fun signed(operation: String, target: String?, body: ByteArray) = work {
        val request = Protocol.signed(body, deviceId, key::sign)
        // Freeze before opening the socket, including on network failure.
        lastRequest = request
        lastOperation = operation
        lastTarget = target
        handle(transport.post(request), operation, target)
    }

    fun replay() {
        val request = lastRequest ?: return
        val operation = lastOperation ?: return
        val target = lastTarget
        work { handle(transport.post(request), operation, target) }
    }

    private fun handle(response: GatewayResponse, operation: String, target: String?) {
        status = response.description()
        if (response.status !in 200..299 || response.error != null) return
        if (operation == "begin") {
            val id = response.id ?: return
            issuedId = id
            revoked = false
            val saved = prefs.edit().putString("issued_id", id).putBoolean("revoked", false).commit()
            status += if (saved) "\nbegin принят. ID сохранён. Загрузка не выполнялась."
                else "\nID: $id\nНе удалось сохранить ID на диск. Запишите его перед закрытием приложения."
        } else if (operation == "revoke" && response.revoked && response.id == target) {
            revoked = true
            val saved = prefs.edit().putBoolean("revoked", true).commit()
            status += if (saved) "\nОтзыв ID подтверждён сервером и сохранён."
                else "\nСервер подтвердил отзыв, но сохранить отметку на телефоне не удалось."
        } else {
            status += "\nОтзыв не подтверждён: проверьте ответ сервера повторным revoke."
        }
    }

    fun deleteKey() = work {
        // Do not silently regenerate on next launch after explicit deletion.
        check(prefs.edit().putBoolean("key_deleted", true).commit())
        key.delete()
        publicKey = null
        deviceId = ""
        issuedId = null
        revoked = false
        lastRequest = null
        lastOperation = null
        lastTarget = null
        check(prefs.edit().remove("device").remove("issued_id").remove("revoked").commit())
        status = "Тестовый ключ удалён из Android Keystore. Удалите запись этого устройства из серверного списка разрешённых ключей."
    }

    private fun work(block: () -> Unit) {
        if (busy) return
        busy = true
        listener?.invoke()
        executor.execute {
            try { block() }
            catch (_: UnknownHostException) { status = "Нет соединения: не удалось найти адрес шлюза. Проверьте интернет и DNS." }
            catch (_: SocketTimeoutException) { status = uncertain("Истекло время ожидания.") }
            catch (_: SSLException) { status = "Ошибка защищённого TLS-соединения. Проверьте дату телефона и сеть." }
            catch (_: ConnectException) { status = "Соединение со шлюзом не установлено. Проверьте интернет." }
            catch (_: java.io.IOException) { status = uncertain("Соединение прервано или локальное хранилище недоступно.") }
            catch (_: Exception) { status = "Не удалось выполнить действие: ошибка ключа, протокола или локального хранения. Временные секреты не выводятся." }
            // No exception messages/stack traces: libraries may include URLs or request material.
            main.post {
                busy = false
                listener?.invoke()
            }
        }
    }

    private fun uncertain(message: String) = "$message\nРезультат неизвестен: сервер мог принять запрос. Повтор использует прежний nonce; после 90 секунд возможен HTTP 401. Если ответ begin потерян, повтор не восстановит выданный ID."
}
