import { runCli } from './run.ts'

const code = await runCli(process.argv.slice(2))
process.exitCode = code
