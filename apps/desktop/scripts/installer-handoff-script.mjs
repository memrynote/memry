#!/usr/bin/env node
// Renders the NSIS -> Velopack hand-off batch script for the smoke workflow.
//
//   node scripts/installer-handoff-script.mjs --pid N --exe Memrynote.exe --install-dir D \
//     --setup S --log L [--nsis-installer P] > handoff.cmd
//
// Mirrors buildInstallerHandoffPlan for the derived paths; the TS module stays
// import-free so Node can strip its types.
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderInstallerHandoffScript } from '../src/main/installer-handoff-script.ts'

const USAGE =
  'usage: installer-handoff-script.mjs --pid N --exe NAME --install-dir DIR --setup PATH --log PATH [--nsis-installer PATH]'

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

process.stdout.write(
  renderInstallerHandoffScript({
    appPid,
    appExeName: options.exe,
    installDir: options['install-dir'],
    uninstallerPath: path.win32.join(options['install-dir'], 'Uninstall MemryNote.exe'),
    workDir: path.win32.join(tmpdir(), `memry-installer-handoff-${appPid}`),
    setupExePath: options.setup,
    setupLogPath: options.log,
    nsisInstallerPath: options['nsis-installer'] ?? null
  })
)
