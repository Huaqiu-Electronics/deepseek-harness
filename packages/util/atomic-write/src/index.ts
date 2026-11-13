/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through an exclusively-created `<file>.lock` sibling, so
 * a read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic. A lock
 * whose recorded holder process no longer exists is taken over, and a lock
 * whose record never finished being published is recovered once it is provably
 * orphaned.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20
const WINDOWS_RENAME_RETRY_MAX_MS = 200
const WINDOWS_RENAME_RETRY_LIMIT = 8
/** Filesystems that cannot make hard links; the exclusive-create fallback covers them. */
const LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EINVAL'])

/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Replace the target after bounded retries for transient Windows interference. */
async function renameAtomicTemp(temp: string, filename: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      await rename(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. Windows replacement retries transient `EACCES`, `EBUSY`,
 * and `EPERM` failures for a bounded interval while the complete temp file
 * remains the rename source. On any remaining failure the temp file is
 * removed and the failure rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string | Uint8Array, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await renameAtomicTemp(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/**
 * Publish a complete `<pid>\n` lock record in one visible step. The record is
 * written to a same-directory temp file and then hard-linked into the lock
 * path: `link` refuses an existing target (`EEXIST`) just like `wx`, while the
 * directory entry only ever appears with the complete record already in the
 * inode. A kill between create and write can therefore no longer leave a
 * 0-byte lock that no contender can identify. Filesystems that reject hard
 * links fall back to the exclusive create they can support.
 */
async function publishLockRecord(lockPath: string, record: string): Promise<void> {
  const temp = `${lockPath}.${randomBytes(6).toString('hex')}.pending`
  try {
    await writeFile(temp, record, { mode: 0o600, flag: 'wx' })
    try {
      await link(temp, lockPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
      // EEXIST/EPERM is contention and must reach the caller unchanged. Only a
      // filesystem that cannot make hard links warrants the weaker fallback.
      if (!LINK_UNSUPPORTED_CODES.has(code)) throw error
      await writeFile(lockPath, record, { mode: 0o600, flag: 'wx' })
    }
  } finally {
    await rm(temp, { force: true }).catch((error: unknown) => {
      // An orphaned temp names no lock and blocks no later acquisition.
      void error
    })
  }
}

/** The holder PID named by a complete `<pid>\n` record, or undefined. */
function parseHolderPid(record: string): number | undefined {
  if (!/^\d+\n$/.test(record)) return undefined
  const pid = Number(record.trim())
  if (!Number.isSafeInteger(pid) || pid === 0 || pid > 0x7fffffff) return undefined
  return pid
}

/** Whether the holder a `<pid>\n` record names is proven gone: a signal probe finds no such process. */
function holderExited(record: string): boolean {
  const pid = parseHolderPid(record)
  // Any other content is a complete record we cannot verify, not a holder we can prove gone.
  if (pid === undefined) return false
  // This process is running; a runtime whose probe cannot see itself must not take over its own lock.
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists under another user.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Whether `record` can only be the residue of an interrupted lock-record
 * publication: the file exists, but no complete `<pid>\n` ever landed. A
 * complete record that merely cannot be verified (`holder\n`, PID 0, an
 * out-of-range PID) is NOT one of these — those stay operator-owned.
 */
function isIncompleteRecord(record: string): boolean {
  if (record === '') return true
  if (!/^\d{1,10}$/.test(record)) return false
  const pid = Number(record)
  return pid > 0 && pid <= 0x7fffffff
}

/** Whether a partial PID record still names a process that could be mid-write. */
function incompleteRecordHasLiveWriter(record: string): boolean {
  if (!/^\d{1,10}$/.test(record)) return false
  const pid = Number(record)
  if (pid <= 0 || pid > 0x7fffffff) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists under another user; keep its lock.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * How long an incomplete record must stay untouched before a contender may
 * consider its writer gone. It exceeds the longest protocol retry interval by
 * a wide margin, so a writer that is still publishing will have completed its
 * record long before this elapses; a clock-skewed mtime cannot shorten it,
 * because the contender also times its own observation. This is a necessary
 * condition, never a sufficient one on its own.
 */
const INCOMPLETE_LOCK_GRACE_MS = 1_000

/** One contender's observation of an incomplete record across its retries. */
interface OrphanObservation {
  record: string
  observedAt: number
  mtimeMs: number | undefined
}

/** Age of the lock record in milliseconds, or undefined when unobservable. */
async function lockRecordMtimeMs(lockPath: string): Promise<number | undefined> {
  try {
    return (await stat(lockPath)).mtimeMs
  } catch (error) {
    void error
    return undefined
  }
}

/** The lock file's content, or undefined when it cannot be read. */
async function readLockRecord(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, 'utf8')
  } catch (error) {
    // A lock that vanished, or that Windows is still deleting, proves nothing about a holder.
    void error
    return undefined
  }
}

/** One bounded diagnostic per recovered lock, never written to a broken stream. */
function reportIncompleteLockRecovery(lockPath: string): void {
  try {
    if (!process.stderr.destroyed) {
      console.warn(`atomic-write: recovered incomplete writer lock at ${lockPath} [lock-incomplete-recovered]`)
    }
  } catch (error) {
    // A broken stderr must not turn a successful recovery into a failed write.
    void error
  }
}

/**
 * Remove a lock under the claim protocol. Contenders that read the same record
 * serialize on one claim file named after it; under the claim the claimant
 * re-reads the lock and re-runs `stillRemovable`, so a removal never deletes a
 * lock another contender acquired after the one this contender inspected,
 * including one whose holder reused an exited PID. The claim is removed in a
 * `finally`; a leftover claim names a record no longer at the lock and blocks
 * no later takeover.
 * @returns Whether this call removed the dead holder's lock.
 */
async function removeLockUnderClaim(
  lockPath: string,
  record: string,
  stillRemovable: (current: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Another contender owns the claim for this record, or Windows still deletes the claim it released.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM') return false
    throw error
  }
  try {
    const current = await readLockRecord(lockPath)
    if (current !== record || !await stillRemovable(current)) return false
    try {
      await rm(lockPath, { force: true })
    } catch (error) {
      // Windows can refuse the removal while other software briefly holds the file; the next attempt retries.
      void error
      return false
    }
    return true
  } finally {
    await rm(claim, { force: true }).catch((error: unknown) => {
      // A claim left behind names a record that is no longer the lock, so it blocks no later takeover.
      void error
    })
  }
}

/**
 * Take over a lock whose holder is provably gone or whose record never
 * finished being published. A complete `<pid>\n` record keeps the original
 * `ESRCH` proof. An incomplete record is only recovered when it has stayed
 * byte-for-byte untouched for the grace period (by the contender's own clock
 * or by the file's mtime), no partial PID in it names a live process, and the
 * same conditions still hold under the claim. A live writer that finishes its
 * record changes the content, which fails the re-check instead of losing its
 * lock. Complete but unverifiable records, and records whose PID is alive, are
 * waited for.
 * @returns Whether this call removed the lock.
 */
async function takeOverLock(lockPath: string, observation: { current?: OrphanObservation }): Promise<boolean> {
  const record = await readLockRecord(lockPath)
  if (record === undefined) return false
  if (holderExited(record)) {
    return await removeLockUnderClaim(lockPath, record, () => holderExited(record))
  }
  if (!isIncompleteRecord(record)) return false

  const now = Date.now()
  const mtimeMs = await lockRecordMtimeMs(lockPath)
  if (observation.current?.record !== record) {
    observation.current = { record, observedAt: now, mtimeMs }
  }
  const observed = observation.current
  const stableByObservation = now - observed.observedAt >= INCOMPLETE_LOCK_GRACE_MS
  const stableByMtime = mtimeMs !== undefined && now - mtimeMs >= INCOMPLETE_LOCK_GRACE_MS
  if (!stableByObservation && !stableByMtime) return false
  if (incompleteRecordHasLiveWriter(record)) return false

  const removed = await removeLockUnderClaim(lockPath, record, async (current) => {
    if (!isIncompleteRecord(current) || incompleteRecordHasLiveWriter(current)) return false
    // The file must still be the same untouched artifact: a writer that
    // completed its record meanwhile would have changed content or mtime.
    const currentMtimeMs = await lockRecordMtimeMs(lockPath)
    return currentMtimeMs !== undefined && currentMtimeMs === observed.mtimeMs
  })
  if (removed) reportIncompleteLockRecovery(lockPath)
  return removed
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * How long a contender waits when the caller states no limit — sized for the
 * render-and-rename cycle every call site had when this package was written.
 * Expiry fails the contender rather than guessing whether the existing lock
 * still has an owner. How long is *worth* waiting is a property of the
 * operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
 * exists; the value here is the floor for an operation that does file work
 * alone.
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** Options for one {@link withFileLock} acquisition. */
export interface FileLockOptions {
  /** Cancel acquisition and contention waits; the operation owns cancellation after it starts. */
  signal?: AbortSignal
  /**
   * Maximum time to wait for the lock, in milliseconds. State one when the
   * holder's operation legitimately runs longer than file work — a credential
   * mutation that refreshes a token performs a network round trip while
   * holding the lock, and leaving the default in place would fail every other
   * writer of the same file for the duration. Waiting is productive: a
   * contender that acquires the lock afterwards re-reads the committed state.
   */
  waitMs?: number
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is an exclusively-created sibling (`<filename>.lock`) published with a
 * complete `<pid>\n` record; paired with the rename-based commit of
 * {@link writeFileAtomic}, readers stay lock-free and only writers contend.
 * `EEXIST` is contention directly; an `EPERM` is contention only when a fresh
 * `lstat` confirms the lock path exists, covering Windows exclusive-create
 * behavior. Windows retries one unconfirmed EPERM because the holder can
 * release before the probe; a repeated unconfirmed permission error is
 * rethrown. A contender removes the lock and retries at once when no process
 * with the recorded PID exists (`ESRCH`), or when an incomplete record is
 * provably orphaned. Any other lock, including one whose holder exists under
 * another user (`EPERM`) or whose record is complete but unverifiable, is
 * waited for. Contention backs off exponentially and times out after the
 * deadline. A holder whose PID a live process reused keeps its lock until an
 * operator removes it. Takeover proves only that the recorded process exited:
 * an operation that starts other writers must stop them with it or leave its
 * successor a way to find them. PIDs are compared on the contender's host, so
 * writers on other hosts or in other PID namespaces sharing the file are
 * unsupported and could both hold the lock. The parent directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  const observation: { current?: OrphanObservation } = {}
  let delay = LOCK_RETRY_INITIAL_MS
  let retriedUnconfirmedPermissionError = false
  for (;;) {
    options?.signal?.throwIfAborted()
    try {
      await publishLockRecord(lockPath, `${process.pid}\n`)
      break
    } catch (error) {
      if (!await isLockContention(error, lockPath)) {
        // Windows can release the competing lock between exclusive create and lstat.
        if (process.platform !== 'win32'
          || (error as NodeJS.ErrnoException | null)?.code !== 'EPERM'
          || retriedUnconfirmedPermissionError) throw error
        retriedUnconfirmedPermissionError = true
      } else if (await takeOverLock(lockPath, observation)) continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await wait(delay, undefined, { signal: options?.signal })
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    options?.signal?.throwIfAborted()
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}
