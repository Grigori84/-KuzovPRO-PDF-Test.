package ru.kuzovpro.gatewaytest

import android.content.Context
import android.util.AtomicFile
import java.io.File

class AndroidCycleDisk(context: Context, fileName: String = "pdf-cycle-v2.json") : CycleDisk {
    private val atomic = AtomicFile(File(context.noBackupFilesDir, fileName))
    override fun load(): CycleState? {
        if (!atomic.baseFile.exists() && !File(atomic.baseFile.path + ".bak").exists()) return null
        return atomic.openRead().use { CycleJson.decode(it.bufferedReader(Charsets.UTF_8).readText()) }
    }
    override fun save(state: CycleState) {
        val data = CycleJson.encode(state).toByteArray(Charsets.UTF_8)
        val stream = atomic.startWrite()
        try {
            stream.write(data)
            atomic.finishWrite(stream) // Atomic rename + fsync before the caller sends anything.
        } catch (error: Exception) {
            atomic.failWrite(stream)
            throw error
        }
    }
}
