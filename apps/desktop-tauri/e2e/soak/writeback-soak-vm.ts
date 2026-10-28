// The write-back soak on the Windows VM. After `install-artifact` and `launch-tauri`:
//
//   export WINVM_HOLDER=<holder>
//   SOAK_HOURS=12 winvm.sh cdp run e2e/soak/writeback-soak-vm.ts
//
// It drives the app over the WebDriver tunnel (`WD_PORT`, which `cdp` sets), quits it in turn
// through the app's own exit and a Windows sign-out (WM_QUERYENDSESSION, the WebView killed with
// it), and starts it again on the same data and vault through the `memry-repro` task that
// `launch-tauri` made. Options are those of `optionsFromEnv`. A pass prints `soak passed`; then
// `winvm.sh logs` must show no `the write-back failed`.
import { execFileSync } from 'node:child_process'
import { resolve, win32 } from 'node:path'

import type { Executor } from '../harness/invoke-test'
import { invokeTest } from '../harness/invoke-test'
import { createClient } from '../../scripts/lib/webdriver-client.mjs'
import { optionsFromEnv, soak } from './writeback-soak'

/**
 * Waits up to 20 s for the app to exit and up to 20 s more for the WebView2 processes of its
 * profile (whose user data dir is under the control file's dirs or the app's identifier), then
 * runs the launch task again. A WebView still holding the profile would race the new instance.
 */
const RELAUNCH = `
function App { @(Get-Process memry-tauri -ErrorAction SilentlyContinue) }
function Views { @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*memry-tauri-data*' -or $_.CommandLine -like '*com.memrynote.memry*' }) }
$deadline = (Get-Date).AddSeconds(20)
while ((App).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
if ((App).Count -gt 0) { 'still-running'; exit }
$deadline = (Get-Date).AddSeconds(20)
while ((Views).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
$views = (Views).Count
schtasks /run /tn memry-repro | Out-Null
"relaunched webviews-left=$views"
`
/** The relaunch script's own waits plus the SSH round trips. */
const RELAUNCH_MS = 120_000
const READY_MS = 120_000

/** `vault_select`, the picker's command, which `invokeTest` does not call (it is not `e2e_`). */
const SELECT_VAULT = `
  const [path, done] = arguments;
  window.__TAURI__.core.invoke('vault_select', { path }).then(
    (value) => done({ ok: true, value }),
    (error) => done({ ok: false, error })
  );
`

export default async function run(): Promise<void> {
  const port = Number(process.env.WD_PORT)
  if (!Number.isInteger(port)) throw new Error('run through `winvm.sh cdp run`, which sets WD_PORT')
  const winvm = process.env.WINVM ?? resolve('../../.pi/skills/vm-repro/scripts/winvm.sh')
  const base = `http://127.0.0.1:${port}`
  const client = createClient(base)
  let session: string = await client.newSession()
  const executor: Executor = {
    execute: (script, ...args) => client.execute(session, script, args),
    executeAsync: (script, ...args) => client.executeAsync(session, script, args)
  }

  async function ready(): Promise<void> {
    const deadline = Date.now() + READY_MS
    while (Date.now() < deadline) {
      try {
        const status = (await (await fetch(`${base}/status`)).json()) as {
          value?: { ready?: boolean }
        }
        if (status.value?.ready) return
      } catch {
        // Not listening yet.
      }
      await new Promise((done) => setTimeout(done, 1_000))
    }
    throw new Error('the app did not answer WebDriver after the relaunch')
  }

  // `launch-tauri` starts on the picker: it copies the vault but seeds no registry. The vault
  // sits beside the data dir (SOAK_VAULT overrides); a relaunch reopens it as the last one.
  const info = await invokeTest<{ appDataDir: string }>({ executor }, 'e2e_app_info')
  const vault =
    process.env.SOAK_VAULT ?? win32.join(win32.dirname(info.appDataDir), 'vault', 'test-vault')
  const opened = (await executor.executeAsync(SELECT_VAULT, vault)) as {
    ok: boolean
    value?: { success: boolean; error?: string | null }
    error?: unknown
  }
  if (!opened.ok || !opened.value?.success) {
    throw new Error(`could not open ${vault}: ${JSON.stringify(opened)}`)
  }

  await soak(
    {
      executor: () => executor,
      async relaunch() {
        const out = execFileSync('bash', [winvm, 'ps'], {
          input: RELAUNCH,
          encoding: 'utf8',
          timeout: RELAUNCH_MS
        })
        if (!out.includes('relaunched')) throw new Error(`the app did not quit within 20 s: ${out}`)
        console.log(
          JSON.stringify({ at: new Date().toISOString(), event: 'relaunch', out: out.trim() })
        )
        await ready()
        session = await client.newSession()
      }
    },
    optionsFromEnv(process.env, ['request-quit', 'session-end'])
  )
}
