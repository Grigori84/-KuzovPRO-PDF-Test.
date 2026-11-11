package ru.kuzovpro.gatewaytest

import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import java.io.ByteArrayOutputStream

object SyntheticPdf {
    const val TITLE = "КузовPRO — тест PDF"
    fun create(): ByteArray {
        val document = PdfDocument()
        try {
            val page = document.startPage(PdfDocument.PageInfo.Builder(595, 842, 1).create())
            page.canvas.drawColor(Color.WHITE)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.rgb(22, 61, 84)
                textSize = 30f
                typeface = Typeface.create("sans-serif", Typeface.BOLD)
                textAlign = Paint.Align.CENTER
            }
            page.canvas.drawText(TITLE, 297.5f, 180f, paint)
            paint.apply { textSize = 17f; typeface = Typeface.create("sans-serif", Typeface.NORMAL) }
            page.canvas.drawText("Искусственный документ для проверки шлюза", 297.5f, 230f, paint)
            page.canvas.drawText("Реальных клиентских данных нет", 297.5f, 260f, paint)
            document.finishPage(page)
            return ByteArrayOutputStream().use { output -> document.writeTo(output); output.toByteArray() }
        } finally { document.close() }
    }
}
