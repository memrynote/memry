import { execFile } from 'child_process'
import os from 'os'
import { createLogger } from './logger'
import { sampleProcess, type ProcessSample } from './process-sample'

const logger = createLogger('LowPriority')

/**
 * How many periods a {@link backgroundDeadline} moves out for a process that
 * keeps using CPU, so a worker spinning in a loop is still stopped.
 */
const MAX_DEADLINE_EXTENSIONS = 8
/** CPU a process must use in one period to count as working. */
const MIN_PROGRESS_SECONDS = 0.1

/**
 * Background work (text extraction, local embeddings) yields the CPU to
 * everything else on the machine. Best effort, the work still runs without it.
 */
export function lowerProcessPriority(pid: number | undefined): void {
  if (!pid) return
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_LOW)
  } catch (error) {
    logger.debug('Could not lower process priority', { pid, error })
  }
}

/**
 * {@link lowerProcessPriority}, and on macOS the background QoS too. A low nice
 * value still runs on the performance cores at full clock whenever the machine
 * is idle, so a vault-wide embedding pass held two of them for as long as it
 * ran and the fans came on. Background QoS keeps the process on the efficiency
 * cores, about four times slower, and holds it back entirely while other work
 * fills the machine: time it with {@link backgroundDeadline}.
 */
export async function moveToBackground(pid: number | undefined): Promise<void> {
  lowerProcessPriority(pid)
  await setBackgroundQos(pid, true)
}

/**
 * Lifts a process out of background QoS while someone waits on it (a search
 * query), or puts it back. No-op off macOS.
 */
export async function setBackgroundQos(
  pid: number | undefined,
  background: boolean
): Promise<void> {
  if (!pid || process.platform !== 'darwin') return
  await new Promise<void>((resolve) => {
    execFile('/usr/sbin/taskpolicy', [background ? '-b' : '-B', '-p', String(pid)], (error) => {
      if (error) logger.warn('Could not change background QoS', { pid, background, error })
      resolve()
    })
  })
}

/**
 * A timeout for a process {@link moveToBackground} put in the background, read
 * every `ms`. A process that used CPU in the period is working: the deadline
 * moves out, up to MAX_DEADLINE_EXTENSIONS times. A runnable process that used
 * none is held back by a busy machine, not hung: the deadline moves out with no
 * limit, since it costs nothing. Any other process has run out of time, and so
 * has every process `ps` cannot read (Windows). Returns the cancel function.
 */
export function backgroundDeadline(
  pid: () => number | undefined,
  ms: number,
  onExpired: () => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  let extensions = 0
  const sample = (): Promise<ProcessSample | undefined> => sampleProcess(pid())
  // A process that has not spawned yet has used no CPU.
  let cpuBefore: number | undefined
  void sample().then((first) => {
    cpuBefore ??= first?.cpuSeconds ?? 0
  })

  const check = async (): Promise<void> => {
    const now = await sample()
    if (cancelled) return
    const progressed =
      now !== undefined &&
      cpuBefore !== undefined &&
      now.cpuSeconds - cpuBefore >= MIN_PROGRESS_SECONDS
    const heldBack = now?.runnable === true && !progressed
    if (now && (heldBack || (progressed && extensions < MAX_DEADLINE_EXTENSIONS))) {
      if (progressed) extensions += 1
      cpuBefore = now.cpuSeconds
      arm()
      return
    }
    onExpired()
  }
  const arm = (): void => {
    timer = setTimeout(() => void check(), ms)
  }
  arm()
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}
