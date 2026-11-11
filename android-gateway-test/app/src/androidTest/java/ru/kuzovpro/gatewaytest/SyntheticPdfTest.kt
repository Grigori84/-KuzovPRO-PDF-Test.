package ru.kuzovpro.gatewaytest

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class SyntheticPdfTest {
    @Test fun generatedPdfRendersOnePageWithVisibleTitleAndSurvivesDiskRoundTrip() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val bytes = SyntheticPdf.create()
        val pdf = PdfPayload(bytes)
        assertEquals("КузовPRO — тест PDF", SyntheticPdf.TITLE)
        assertTrue(bytes.size < 256 * 1024)
        val disk = AndroidCycleDisk(context, "instrumentation-cycle.json")
        val file = File(context.noBackupFilesDir, "render-test.pdf")
        try {
            disk.save(CycleState(CyclePhase.READY, pdf = pdf))
            assertArrayEquals(bytes, disk.load()!!.pdf!!.bytes())
            file.writeBytes(bytes)
            PdfRenderer(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)).use { renderer ->
                assertEquals(1, renderer.pageCount)
                renderer.openPage(0).use { page ->
                    val bitmap = Bitmap.createBitmap(595, 842, Bitmap.Config.ARGB_8888)
                    bitmap.eraseColor(Color.WHITE)
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    var ink = 0
                    for (y in 145..190) for (x in 100..495) if (bitmap.getPixel(x, y) != Color.WHITE) ink++
                    assertTrue("Title area is blank", ink > 500)
                    bitmap.recycle()
                }
            }
        } finally {
            File(context.noBackupFilesDir, "instrumentation-cycle.json").delete()
            file.delete()
        }
    }
}
