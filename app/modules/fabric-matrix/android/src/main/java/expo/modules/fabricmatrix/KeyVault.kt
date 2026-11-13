package expo.modules.fabricmatrix

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class StoreLockedException(msg: String) : Exception(msg)

/**
 * Holds secrets for the Matrix store on this device.
 * A random 32-byte store key is created natively and saved only wrapped (AES-256-GCM) by a
 * non-exportable Android Keystore key. The same wrapping protects the saved session.
 * Nothing here is ever returned to JavaScript or logged.
 */
class KeyVault(private val dir: File, private val alias: String = "fabric_store_wrap") {
  private val keyFile = File(dir, "store.key.enc")
  private val sessionFile = File(dir, "session.enc")
  private val ks: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  init { dir.mkdirs() }

  private fun wrapKey(create: Boolean): SecretKey {
    (ks.getKey(alias, null) as? SecretKey)?.let { return it }
    if (!create) throw StoreLockedException("wrapping key missing")
    val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    g.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return g.generateKey()
  }

  private fun seal(plain: ByteArray, create: Boolean): ByteArray {
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, wrapKey(create))
    return c.iv + c.doFinal(plain)
  }

  private fun open(blob: ByteArray): ByteArray = try {
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.DECRYPT_MODE, wrapKey(false), GCMParameterSpec(128, blob, 0, 12))
    c.doFinal(blob, 12, blob.size - 12)
  } catch (e: StoreLockedException) { throw e } catch (e: Exception) {
    throw StoreLockedException("unwrap failed")
  }

  fun hasKey() = keyFile.exists()

  /** Creates a new store key. Refuses if one exists (never silently replaces). */
  fun createStoreKey(): ByteArray {
    if (keyFile.exists()) throw IllegalStateException("store key exists")
    val k = ByteArray(32).also { SecureRandom().nextBytes(it) }
    keyFile.writeBytes(seal(k, create = true))
    return k
  }

  /** Fails closed: no file, no Keystore key, or tampered blob -> StoreLockedException. */
  fun loadStoreKey(): ByteArray {
    if (!keyFile.exists()) throw StoreLockedException("store key missing")
    return open(keyFile.readBytes())
  }

  fun saveSession(bytes: ByteArray) = sessionFile.writeBytes(seal(bytes, create = false))
  fun loadSession(): ByteArray? = if (sessionFile.exists()) open(sessionFile.readBytes()) else null

  fun wipe() {
    keyFile.delete(); sessionFile.delete()
    if (ks.containsAlias(alias)) ks.deleteEntry(alias)
  }
}
