import { readFileSync } from 'node:fs'
import path from 'node:path'
import { formatMemoryComparison } from '../src/main/debug/memory-compare'

function printHelp(): void {
  console.log('Usage: pnpm memory:compare <main.json> <branch.json>')
}

function resolveInputPath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return inputPath
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), inputPath)
}

function readJson(inputPath: string): unknown {
  return JSON.parse(readFileSync(resolveInputPath(inputPath), 'utf-8'))
}

const [, , baselinePath, candidatePath] = process.argv

if (!baselinePath || !candidatePath || baselinePath === '--help') {
  printHelp()
  process.exit(baselinePath === '--help' ? 0 : 1)
}

console.log(
  formatMemoryComparison(readJson(baselinePath) as never, readJson(candidatePath) as never)
)
