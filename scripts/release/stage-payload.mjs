// Stages the Windows pack dir for `vpk [win] pack`: the Tauri binary as Memrynote.exe plus every
// file `tauri.conf.json` lists under bundle.resources or bundle.externalBin that the build placed
// beside the executable (the Tauri resource directory on Windows is the executable directory).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const WINDOWS_MAIN_EXE = 'Memrynote.exe'

/** Paths (relative to the exe directory) a bundle config expects beside the executable. */
export function listCompanionPaths(config) {
  const bundle = config.bundle ?? {}
  const paths = []

  for (const bin of bundle.externalBin ?? []) {
    paths.push(`${path.posix.basename(bin)}.exe`)
  }

  const resources = bundle.resources ?? []
  const targets = Array.isArray(resources) ? resources : Object.values(resources)
  for (const resource of targets) {
    const literal = resource.split('*')[0].replace(/\/+$/, '')
    if (literal) {
      paths.push(
        literal
          .split('/')
          .map((part) => (part === '..' ? '_up_' : part))
          .join('/')
      )
    }
  }

  return paths
}

export function stageWindowsPayload({ exeDir, exeName = 'memry-tauri.exe', config, outDir }) {
  const mainExe = path.join(exeDir, exeName)
  if (!existsSync(mainExe)) {
    throw new Error(`The build produced no ${exeName} in ${exeDir}`)
  }

  const missing = listCompanionPaths(config).filter((rel) => !existsSync(path.join(exeDir, rel)))
  if (missing.length > 0) {
    throw new Error(
      `tauri.conf.json lists files the build did not place beside the exe: ${missing.join(', ')}`
    )
  }

  rmSync(outDir, { force: true, recursive: true })
  mkdirSync(outDir, { recursive: true })
  cpSync(mainExe, path.join(outDir, WINDOWS_MAIN_EXE))

  const staged = [WINDOWS_MAIN_EXE]
  for (const rel of listCompanionPaths(config)) {
    const from = path.join(exeDir, rel)
    cpSync(from, path.join(outDir, rel), { recursive: statSync(from).isDirectory() })
    staged.push(rel)
  }
  return staged
}

function main(argv) {
  const [os, triple, outDir] = argv
  if (os !== 'win' || !triple || !outDir) {
    console.error('usage: stage-payload.mjs win <target-triple> <out-dir>')
    process.exit(2)
  }
  const tauriDir = path.resolve('apps/desktop-tauri/src-tauri')
  const config = JSON.parse(readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'))
  const exeDir = path.resolve('crates/target', triple, 'release')
  const staged = stageWindowsPayload({ exeDir, config, outDir: path.resolve(outDir) })
  console.log(`Staged ${staged.length} entries into ${outDir}: ${staged.join(', ')}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
