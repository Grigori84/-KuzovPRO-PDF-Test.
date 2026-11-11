package ru.kuzovpro.gatewaytest

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.ActivityNotFoundException
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.widget.ImageView
import java.io.File
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
    private lateinit var prepare: Button
    private lateinit var preview: Button
    private lateinit var full: Button
    private lateinit var upload: Button
    private lateinit var publish: Button
    private lateinit var check: Button
    private lateinit var open: Button

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
        text("Искусственный PDF: одна страница, без клиентских данных. Приложение не переключает шлюз. До отдельного разрешения шлюз остаётся отключённым.")
        text(Protocol.ENDPOINT, 13f)
        deviceText = text("")
        copyDevice = button("Копировать ID устройства") { copy("ID тестового устройства", session.deviceId) }
        text("Публичный ключ · Base64 DER/SPKI", 17f)
        keyText = text("", 13f).apply { setTextIsSelectable(true) }
        copyKey = button("Копировать публичный ключ") { session.publicKey?.let { copy("Публичный ключ", it) } }
        create = button("Создать тестовый ключ") { session.createKey() }
        text("Перед тестом владелец сервера регистрирует эту пару ID + публичный ключ. Включите автоматические дату и время на Samsung.")
        unsigned = button("Без подписи") { session.unsigned() }
        prepare = button("Создать тестовый PDF (локально)") { session.preparePdf() }
        preview = button("Посмотреть PDF локально") { previewLocalPdf() }
        full = button("Полный цикл: begin → PUT → publish") {
            AlertDialog.Builder(this).setTitle("Опубликовать искусственный PDF?")
                .setMessage("Будет отправлен только созданный тестовый PDF. При отключённом шлюзе ожидается HTTP 503. Настройки шлюза приложение не меняет.")
                .setNegativeButton("Отмена", null)
                .setPositiveButton("Начать тест") { _, _ -> session.fullCycle() }.show()
        }
        begin = button("Подписанный begin") { session.begin() }
        upload = button("Загрузить PDF: HTTPS PUT") { session.upload() }
        publish = button("Продолжить publish того же ID") { session.publish() }
        replay = button("Повторить запрос") { session.replay() }
        text("Повтор отправляет последний подписанный POST без новой подписи; PUT не повторяется. Для восстановления после обрыва используйте publish или revoke того же ID: они создают новый nonce. Новый begin при неизвестном результате заблокирован.", 14f)
        idText = text("").apply { setTextIsSelectable(true) }
        open = button("Открыть PDF.js в Samsung Internet") { openViewer() }
        check = button("Проверить документ без кэша") { session.checkDocument() }
        revoke = button("Отозвать") { session.revoke() }
        statusText = text("", 17f).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        delete = button("Удалить тестовый ключ") {
            AlertDialog.Builder(this)
                .setTitle("Удалить тестовый ключ?")
                .setMessage("Доступно после подтверждённого отзыва и проверки недоступности. Закрытый ключ будет удалён; искусственный PDF и подтверждённое состояние останутся на телефоне. После удаления уберите устройство из серверного списка ключей.")
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
        val state = session.state
        idText.text = buildString {
            append(state?.id?.let { "ID: $it" } ?: "ID пока не получен.")
            append("\nЭтап: " + phaseLabel(state?.phase))
            state?.pdf?.let { append("\nPDF: ${it.size} байт\nSHA-256: ${it.sha256}") }
            if (state?.availableVerified == true) append("\nРазмер и SHA-256 скачанного PDF проверены.")
            if (state?.unavailableVerified == true) append("\nНедоступность после revoke подтверждена.")
            if (state?.id != null && state.pdf == null) append("\nID из версии 0.1: доступен отзыв, публикация этих данных запрещена.")
        }
        statusText.text = if (session.busy) "Выполняется… " + phaseLabel(state?.phase) else session.status
        unsigned.isEnabled = !session.busy
        begin.isEnabled = !session.busy && session.canBegin
        prepare.isEnabled = !session.busy && session.canPrepare
        preview.isEnabled = !session.busy && state?.pdf != null
        full.isEnabled = !session.busy && session.canBegin
        upload.isEnabled = !session.busy && session.canPut
        publish.isEnabled = !session.busy && session.canPublish
        check.isEnabled = !session.busy && state?.id != null
        open.isEnabled = !session.busy && session.viewerUrl != null
        replay.isEnabled = !session.busy && session.canReplay
        revoke.isEnabled = !session.busy && session.canRevoke
        copyKey.isEnabled = !session.busy && session.publicKey != null
        copyDevice.isEnabled = !session.busy && session.deviceId.isNotEmpty()
        create.visibility = if (session.publicKey == null) View.VISIBLE else View.GONE
        create.isEnabled = !session.busy
        delete.isEnabled = !session.busy && session.canDeleteKey
    }
    private fun openViewer() {
        val url = session.viewerUrl ?: return
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        try { startActivity(Intent(intent).setPackage("com.sec.android.app.sbrowser")) }
        catch (_: ActivityNotFoundException) {
            try { startActivity(intent) } catch (_: ActivityNotFoundException) { session.browserFailed() }
        }
    }
    private fun previewLocalPdf() {
        val pdf = session.state?.pdf ?: return
        val file = File(noBackupFilesDir, "local-preview.pdf")
        try {
            file.writeBytes(pdf.bytes())
            val bitmap = PdfRenderer(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)).use { renderer ->
                require(renderer.pageCount == 1)
                renderer.openPage(0).use { page ->
                    Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888).also {
                        page.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    }
                }
            }
            val image = ImageView(this).apply { setImageBitmap(bitmap); adjustViewBounds = true }
            AlertDialog.Builder(this).setTitle("Локальный искусственный PDF")
                .setView(ScrollView(this).apply { addView(image) }).setPositiveButton("Закрыть", null).show()
        } catch (_: Exception) {
            Toast.makeText(this, "Не удалось показать локальный PDF. Сохранённые байты не изменены.", Toast.LENGTH_LONG).show()
        } finally { file.delete() }
    }
    private fun phaseLabel(phase: CyclePhase?): String = when (phase) {
        null -> "состояние не загружено"
        CyclePhase.EMPTY -> "PDF ещё не создан"
        CyclePhase.READY -> "PDF сохранён, begin не выполнялся"
        CyclePhase.BEGIN_PENDING -> "ожидание begin"
        CyclePhase.BEGIN_UNKNOWN -> "результат begin неизвестен; новый begin запрещён"
        CyclePhase.ISSUED -> "ID сохранён; загрузка не подтверждена"
        CyclePhase.PUT_PENDING -> "загрузка PUT"
        CyclePhase.UPLOAD_UNKNOWN -> "результат PUT неизвестен"
        CyclePhase.UPLOADED -> "PUT подтверждён"
        CyclePhase.PUBLISH_PENDING -> "ожидание publish"
        CyclePhase.PUBLISH_UNKNOWN -> "публикация не подтверждена; сохранён прежний ID"
        CyclePhase.PUBLISHED -> "опубликован"
        CyclePhase.REVOKE_PENDING -> "ожидание revoke"
        CyclePhase.REVOKE_UNKNOWN -> "отзыв не подтверждён"
        CyclePhase.REVOKED -> "отзыв подтверждён"
    }
    private fun copy(label: String, value: String) {
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(label, value))
        Toast.makeText(this, "Скопировано", Toast.LENGTH_SHORT).show()
    }
    private fun dp(value: Int): Int = (resources.displayMetrics.density * value).toInt()
}
