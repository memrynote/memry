// Metro config for the pnpm monorepo (spec 001-mobile-app T002 / R3).
//
// The repo installs with pnpm + shamefullyHoist; workspace packages
// (@memry/contracts, later the pure app-core slice and @memry/sync-client)
// are consumed via their raw `./src/*.ts` exports — Metro transpiles workspace
// TS sources directly, no build step. Package-exports resolution is default
// since Metro 0.82; monorepo watching is automatic since SDK 52. Both are made
// explicit here so R3 findings have one home and regressions are loud.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// Watch the whole workspace so edits to packages/* hot-reload.
config.watchFolders = [workspaceRoot]

// Resolve from the app first, then the hoisted root node_modules.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules')
]

// Raw-TS workspace exports depend on package-exports resolution (R3).
config.resolver.unstable_enablePackageExports = true

// yjs → lib0 resolves `lib0/webcrypto` to its react-native build, which
// requires the unmaintained `isomorphic-webcrypto` (native deps, prebuild
// churn). The surface lib0 uses is three members, served by the app's
// libsodium-backed crypto polyfill instead (src/lib/isomorphic-webcrypto-shim.js).
const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'isomorphic-webcrypto/src/react-native') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(projectRoot, 'src/lib/isomorphic-webcrypto-shim.js')
    }
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
