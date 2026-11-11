package ru.kuzovpro.gatewaytest

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var session: TestSession
    private lateinit var keyText: TextView
    private lateinit var deviceText: TextView
    private lateinit var idText: TextView
    private lateinit var statusText: TextView
    private lateinit var begin: Button
    private lateinit var unsigned: Button
    private lateinit var replay: Button
    private lateinit var revoke: Button
    private lateinit var copyKey: Button
    private lateinit var copyDevice: Button
    private lateinit var create: Button
    private lateinit var delete: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        session = (application as GatewayTestApp).session
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = dp(18)
            setPadding(pad, pad, pad, pad)
        }
        @Suppress("DEPRECATION") // WindowInsets legacy accessors keep API 26–29 supported.
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(column)
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                insets
            }
        }
        fun text(value: String, size: Float = 16f) = TextView(this).apply {
            text = value; textSize = size; setPadding(0, dp(8), 0, dp(8))
            column.addView(this)
        }
        fun button(value: String, action: () -> Unit) = Button(this).apply {
            text = value; isAllCaps = false; minHeight = dp(48)
            setOnClickListener { action() }
            column.addView(this, LinearLayout.LayoutParams(-1, -2))
        }
        text("КузовPRO — тест шлюза", 23f)
        text("Только искусственный тест авторизации. Кнопки отправляют POST. PDF, PUT и публикация не используются.")
        text(Protocol.ENDPOINT, 13f)
        deviceText = text("")
        copyDevice = button("Копировать ID устройства") { copy("ID тестового устройства", session.deviceId) }
        text("Публичный ключ · Base64 DER/SPKI", 17f)
        keyText = text("", 13f).apply { setTextIsSelectable(true) }
        copyKey = button("Копировать публичный ключ") { session.publicKey?.let { copy("Публичный ключ", it) } }
        create = button("Создать тестовый ключ") { session.createKey() }
        text("Перед тестом владелец сервера регистрирует эту пару ID + публичный ключ. Включите автоматические дату и время на Samsung.")
        unsigned = button("Без подписи") { session.unsigned() }
        begin = button("Подписанный begin") { session.begin() }
        replay = button("Повторить запрос") { session.replay() }
        text("Повтор отправляет те же байты и заголовки последнего подписанного begin/revoke. Доступен до закрытия процесса. В пределах 90 секунд ожидается HTTP 409 REPLAYED_REQUEST, если исходный запрос был принят.", 14f)
        idText = text("").apply { setTextIsSelectable(true) }
        revoke = button("Отозвать") { session.revoke() }
        statusText = text("", 17f).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        delete = button("Удалить тестовый ключ") {
            AlertDialog.Builder(this)
                .setTitle("Удалить тестовый ключ?")
                .setMessage("Сначала отзовите выданный ID. Удаление ключа само по себе не отзывает ID на сервере. Локальные ID и возможность повтора будут удалены. После удаления уберите устройство из серверного списка ключей.")
                .setNegativeButton("Отмена", null)
                .setPositiveButton("Удалить") { _, _ -> session.deleteKey() }
                .show()
        }
        setContentView(scroll)
        render()
    }

    override fun onStart() {
        super.onStart()
        session.listener = { render() }
        render()
    }
    override fun onStop() {
        session.listener = null
        super.onStop()
    }
    private fun render() {
        deviceText.text = getString(R.string.device_identity, session.deviceId.ifEmpty { "ещё не создан" })
        keyText.text = session.publicKey ?: "Ключ отсутствует или ещё подготавливается."
        idText.text = session.issuedId?.let { "Выданный ID: $it\n" + if (session.revoked) "Отзыв подтверждён." else "Ожидает отзыва." }
            ?: "Выданного ID пока нет."
        statusText.text = if (session.busy) "Выполняется…" else session.status
        unsigned.isEnabled = !session.busy
        begin.isEnabled = !session.busy && session.canBegin
        replay.isEnabled = !session.busy && session.canReplay
        revoke.isEnabled = !session.busy && session.issuedId != null && !session.revoked && session.publicKey != null
        copyKey.isEnabled = !session.busy && session.publicKey != null
        copyDevice.isEnabled = !session.busy && session.deviceId.isNotEmpty()
        create.visibility = if (session.publicKey == null) View.VISIBLE else View.GONE
        create.isEnabled = !session.busy
        delete.isEnabled = !session.busy && session.publicKey != null
    }
    private fun copy(label: String, value: String) {
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(label, value))
        Toast.makeText(this, "Скопировано", Toast.LENGTH_SHORT).show()
    }
    private fun dp(value: Int): Int = (resources.displayMetrics.density * value).toInt()
}
