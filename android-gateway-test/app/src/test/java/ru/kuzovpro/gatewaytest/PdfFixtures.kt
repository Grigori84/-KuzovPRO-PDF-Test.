package ru.kuzovpro.gatewaytest

import java.io.ByteArrayOutputStream

object PdfFixtures {
    fun onePage(): ByteArray {
        val stream = "BT /F1 24 Tf 50 150 Td (Synthetic gateway PDF) Tj ET\n"
        val objects = listOf(
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            "<< /Length ${stream.length} >>\nstream\n${stream}endstream"
        )
        val out = ByteArrayOutputStream()
        fun write(s: String) { out.write(s.toByteArray(Charsets.US_ASCII)) }
        write("%PDF-1.4\n")
        val offsets = mutableListOf(0)
        objects.forEachIndexed { i, obj -> offsets += out.size(); write("${i + 1} 0 obj\n$obj\nendobj\n") }
        val xref = out.size()
        write("xref\n0 ${objects.size + 1}\n0000000000 65535 f \n")
        offsets.drop(1).forEach { write("%010d 00000 n \n".format(it)) }
        write("trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n")
        return out.toByteArray()
    }
    val id = "a".repeat(32)
    fun ticket(pdf: PdfPayload) = UploadTicket(
        "https://storage.yandexcloud.net/offline-private/staging/$id.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${"a".repeat(64)}&X-Amz-Expires=300&X-Amz-SignedHeaders=content-length%3Bcontent-md5%3Bcontent-type%3Bhost%3Bif-none-match",
        mapOf("Content-Type" to "application/pdf", "Content-Length" to pdf.size.toString(), "Content-MD5" to pdf.md5, "If-None-Match" to "*"), 300)
}
