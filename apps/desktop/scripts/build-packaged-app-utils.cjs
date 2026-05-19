const ARCH_FLAGS = new Map([
  ['--x64', 'x64'],
  ['--arm64', 'arm64'],
  ['--ia32', 'ia32'],
  ['--armv7l', 'armv7l'],
  ['--universal', 'universal']
])

function assertProductionSyncServerUrl(syncServerUrl) {
  const value = syncServerUrl?.trim()
  if (!value) {
    throw new Error('production SYNC_SERVER_URL must be configured')
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('production SYNC_SERVER_URL must be a valid URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('production SYNC_SERVER_URL must use HTTPS')
  }

  const hostname = parsed.hostname.toLowerCase()
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  if (localHosts.has(hostname) || hostname.includes('sync-staging')) {
    throw new Error('production SYNC_SERVER_URL must point to the production sync host')
  }
}

function resolveTargetArch(args, hostArch = process.arch) {
  const archs = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (ARCH_FLAGS.has(arg)) {
      archs.push(ARCH_FLAGS.get(arg))
      continue
    }

    if (arg === '--arch' || arg === '-a') {
      const value = args[index + 1]
      if (value) {
        archs.push(value)
        index += 1
      }
      continue
    }

    if (arg.startsWith('--arch=')) {
      archs.push(arg.slice('--arch='.length))
    }
  }

  const uniqueArchs = [...new Set(archs)]

  if (uniqueArchs.length > 1) {
    throw new Error(
      `Build one mac architecture at a time so staged native modules are rebuilt for that architecture: ${uniqueArchs.join(', ')}`
    )
  }

  if (uniqueArchs[0] === 'universal') {
    throw new Error('Universal mac builds are not supported by the staged native-module packager')
  }

  return uniqueArchs[0] ?? hostArch
}

module.exports = {
  assertProductionSyncServerUrl,
  resolveTargetArch
}
