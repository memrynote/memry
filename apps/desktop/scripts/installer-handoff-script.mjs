#!/usr/bin/env node
// Renders the NSIS -> Velopack hand-off batch script for the smoke workflow.
//
//   node scripts/installer-handoff-script.mjs --pid N --exe Memrynote.exe --install-dir D \
//     --setup S --log L [--nsis-installer P] > handoff.cmd
//   node scripts/installer-handoff-script.mjs ... --spawn handoff.cmd
//
// `--spawn P` writes the script to P and starts it detached with HANDOFF_SPAWN_OPTIONS, the exact
// options the app uses, then exits like the quitting app does. Starting it any other way (the
// smoke workflow used `Start-Process -WindowStyle Hidden`) gives cmd.exe a console, which hides
// every problem a console-less cmd.exe has.
//
// Mirrors buildInstallerHandoffPlan for the derived paths; the TS module stays
// import-free so Node can strip its types.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  HANDOFF_SPAWN_OPTIONS,
  renderInstallerHandoffScript
} from '../src/main/installer-handoff-script.ts'

const USAGE =
  'usage: installer-handoff-script.mjs --pid N --exe NAME --install-dir DIR --setup PATH --log PATH [--nsis-installer PATH] [--spawn SCRIPT_PATH]'

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key.startsWith('--') || value === undefined) {
      return null
    }
    options[key.slice(2)] = value
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const required = ['pid', 'exe', 'install-dir', 'setup', 'log']
if (!options || required.some((key) => !options[key])) {
  process.stderr.write(`${USAGE}\n`)
  process.exit(2)
}

const appPid = Number(options.pid)
if (!Number.isInteger(appPid) || appPid <= 0) {
  process.stderr.write(`--pid must be a positive integer, got ${options.pid}\n`)
  process.exit(2)
}

const script = renderInstallerHandoffScript({
  appPid,
  appExeName: options.exe,
  installDir: options['install-dir'],
  uninstallerPath: path.win32.join(options['install-dir'], 'Uninstall MemryNote.exe'),
  workDir: path.win32.join(tmpdir(), `memry-installer-handoff-${appPid}`),
  setupExePath: options.setup,
  setupLogPath: options.log,
  handoffLogPath: path.win32.join(path.win32.dirname(options.log), 'installer-handoff.log'),
  nsisInstallerPath: options['nsis-installer'] ?? null
})

if (options.spawn) {
  writeFileSync(options.spawn, script)
  spawn('cmd.exe', ['/c', options.spawn], HANDOFF_SPAWN_OPTIONS).unref()
} else {
  process.stdout.write(script)
}
