import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Plugin } from 'vite'

// The desktop dev scripts reuse the last dev build of main and preload when nothing it was
// built from has changed, so a restart after a renderer-only change skips the main build,
// which takes most of `pnpm dev`'s start-up. Every full dev build records each file the two
// builds read or wrote, with its size and mtime, and the electron-vite arguments.
// scripts/dev.mjs compares them before it starts electron-vite.

type FileState = [path: string, size: number | null, mtimeMs: number | null]
type DevBuildRecord = { args: string[]; files: FileState[] }

// Not under out/: packaging copies out/ whole.
const recordPath = (appRoot: string): string => join(appRoot, 'node_modules', '.dev-build.json')

function fileState(path: string): FileState {
  const stats = statSync(path, { throwIfNoEntry: false })
  return [path, stats?.size ?? null, stats?.mtimeMs ?? null]
}

export function lastDevBuildIsCurrent(appRoot: string, args: string[]): boolean {
  let record: DevBuildRecord
  try {
    record = JSON.parse(readFileSync(recordPath(appRoot), 'utf8'))
  } catch {
    // No record yet, or an unreadable one: build.
    return false
  }
  return (
    JSON.stringify(record.args) === JSON.stringify(args) &&
    record.files.every((recorded) => fileState(recorded[0]).join() === recorded.join())
  )
}

const build = { inputs: new Set<string>(), outDirs: new Set<string>() }

// `electron-vite dev` builds main, then preload. The main build drops the old record before
// it reads anything, and the preload build writes the new one after both have written their
// output, so a failed or interrupted build leaves no record and the next start builds again.
export function recordDevBuild(appRoot: string, step: 'main' | 'preload'): Plugin {
  return {
    name: 'record-dev-build',
    buildStart() {
      if (step !== 'main') return
      rmSync(recordPath(appRoot), { force: true })
      build.inputs.clear()
      build.outDirs.clear()
    },
    writeBundle(options) {
      for (const file of this.getWatchFiles()) build.inputs.add(file)
      if (options.dir) build.outDirs.add(options.dir)
      if (step === 'preload') writeRecord(appRoot)
    }
  }
}

function writeRecord(appRoot: string): void {
  const workspaceRoot = join(appRoot, '..', '..')
  // Rollup does not watch tsconfig files, but they change how TypeScript compiles.
  const packageDirs = [...build.inputs]
    .filter((file) => basename(file) === 'package.json' && !file.includes('node_modules'))
    .map((file) => dirname(file))
  const tsconfigs = [workspaceRoot, ...packageDirs].flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => /^tsconfig.*\.json$/.test(name))
      .map((name) => join(dir, name))
  )
  const outputs = [...build.outDirs].flatMap((dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
  )
  const files = [
    ...build.inputs,
    ...tsconfigs,
    join(appRoot, 'electron.vite.config.ts'),
    join(workspaceRoot, 'pnpm-lock.yaml'),
    ...outputs
  ]
  // This runs inside the electron-vite CLI, whose argv is [node, cli, 'dev', ...flags].
  const record: DevBuildRecord = { args: process.argv.slice(2), files: files.map(fileState) }
  writeFileSync(recordPath(appRoot), JSON.stringify(record))
}
