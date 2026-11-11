package ru.kuzovpro.gatewaytest

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.InputStream

data class GatewayResponse(val status: Int, val error: String?, val id: String?, val revoked: Boolean) {
    fun description(): String {
        val meaning = when (error) {
            "UNAUTHORIZED" -> "Авторизация отклонена: проверьте регистрацию ключа и время телефона."
            "REPLAYED_REQUEST" -> "Сервер отклонил повтор nonce — защита от повтора сработала."
            "GATEWAY_DISABLED" -> "Тестовый шлюз выключен на сервере."
            "GATEWAY_UNAVAILABLE" -> "Шлюз временно недоступен или сервер не настроен."
            "PUBLICATION_ACCESS_DENIED" -> "ID выдан другому устройству."
            "UNKNOWN_PUBLICATION_ID" -> "Сервер не знает этот ID."
            "PUBLISHING_IN_PROGRESS_RETRY" -> "Отзыв пока не подтверждён: сервер занят."
            "INVALID_RESPONSE" -> "Ответ не соответствует протоколу; результат не подтверждён."
            "RESPONSE_TOO_LARGE" -> "Ответ превышает безопасный размер; результат не подтверждён."
            "RESPONSE_READ_FAILED" -> "HTTP-статус получен, но чтение ответа прервано. Результат операции неизвестен."
            else -> when (status) {
                in 300..399 -> "Перенаправление отклонено. Запрос по другому адресу не отправлялся."
                401 -> "Требуется авторизация."
                403 -> "Доступ запрещён."
                429 -> "Слишком много запросов. Повторите позднее."
                in 500..599 -> "Ошибка сервера или API Gateway."
                in 200..299 -> "Ответ получен."
                else -> "Шлюз отклонил запрос."
            }
        }
        return "HTTP $status" + (error?.let { " · $it" } ?: "") + "\n" + meaning
    }
}

class GatewayTransport(
    private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }
) {
    // Fixed destination, no configurable host, no PUT/publish, no automatic application retries.
    fun post(request: GatewayRequest): GatewayResponse {
        val connection = open(URL(Protocol.ENDPOINT))
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.useCaches = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", "application/json")
            request.signatureHeaders().forEach { (name, value) -> connection.setRequestProperty(name, value) }
            val body = request.bodyBytes()
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            if (status in 300..399) return GatewayResponse(status, null, null, false)
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            return parse(status, stream)
        } finally { connection.disconnect() }
    }

    private fun parse(status: Int, stream: InputStream?): GatewayResponse {
        if (stream == null) return GatewayResponse(status, "INVALID_RESPONSE", null, false)
        // Never expose the raw response (it can contain a signed PUT URL).
        val raw = try { stream.use { it.readNBytesCompat(16 * 1024 + 1) } }
            catch (_: java.io.IOException) { return GatewayResponse(status, "RESPONSE_READ_FAILED", null, false) }
        if (raw.size > 16 * 1024) return GatewayResponse(status, "RESPONSE_TOO_LARGE", null, false)
        return try {
            val obj = JSONObject(String(raw, Charsets.UTF_8))
            val error = (obj.opt("error") as? String)?.takeIf { Regex("[A-Z][A-Z0-9_]{0,63}").matches(it) }
            val id = (obj.opt("id") as? String)?.takeIf { Protocol.idPattern.matches(it) }
            val revoked = obj.opt("revoked") == true
            val valid = if (status in 200..299) id != null && error == null else error != null
            GatewayResponse(status, if (valid) error else "INVALID_RESPONSE", id, revoked)
        } catch (_: Exception) { GatewayResponse(status, "INVALID_RESPONSE", null, false) }
    }

    private fun InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(2048)
        while (out.size() < limit) {
            val count = read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (count < 0) break
            out.write(buffer, 0, count)
        }
        return out.toByteArray()
    }
}
