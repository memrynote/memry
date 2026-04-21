const DEFAULT_HOSTNAME = 'sync.memrynote.com'
const DEFAULT_PORT = 443

export function parseExtractCertHashArgs(
  argv: readonly string[]
): { hostname: string; port: number } {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const hostname = args[0] || DEFAULT_HOSTNAME
  const portArg = args[1]

  if (!portArg) {
    return { hostname, port: DEFAULT_PORT }
  }

  const port = Number.parseInt(portArg, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portArg}`)
  }

  return { hostname, port }
}
