package expo.modules.fabricmatrix

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File

/**
 * Hands each test method its own never-used owner/peer accounts from the pool created by
 * server/make-gate-users.sh, so methods in one class share no accounts, devices or stores.
 */
object GatePool {
  data class Account(val user: String, val password: String)
  private val args get() = InstrumentationRegistry.getArguments()
  private val counter get() = File(InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir, "gate-pool-next")

  @Synchronized fun nextPair(): Pair<Account, Account> {
    val pool = args.getString("pool")!!.split(",")
    val i = counter.takeIf { it.exists() }?.readText()?.toInt() ?: 0
    check(2 * i + 1 < pool.size) { "gate pool exhausted: create more pairs" }
    counter.writeText((i + 1).toString())
    fun acc(u: String) = Account(u, args.getString("pw.$u")!!)
    return acc(pool[2 * i]) to acc(pool[2 * i + 1])
  }
}
