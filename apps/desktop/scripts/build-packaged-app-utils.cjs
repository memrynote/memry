const ARCH_FLAGS = new Map([
  ['--x64', 'x64'],
  ['--arm64', 'arm64'],
  ['--ia32', 'ia32'],
  ['--armv7l', 'armv7l'],
  ['--universal', 'universal']
])

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
  resolveTargetArch
}
