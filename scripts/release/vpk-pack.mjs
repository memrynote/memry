#!/usr/bin/env node
// Runs `vpk pack` for one target with the argument list of vpk-args.mjs.
// Usage: node scripts/release/vpk-pack.mjs <target> --version V --pack-dir D --output-dir O
//        [--delta None|BestSpeed|BestSize] [--icon P] [--sign-template T]
//        [--identity I --entitlements P --notary-profile N --keychain K]
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { buildPackArgs } from './vpk-args.mjs'

export function parsePackCli(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      'pack-dir': { type: 'string' },
      'output-dir': { type: 'string' },
      delta: { type: 'string' },
      icon: { type: 'string' },
      'sign-template': { type: 'string' },
      identity: { type: 'string' },
      entitlements: { type: 'string' },
      'notary-profile': { type: 'string' },
      keychain: { type: 'string' }
    }
  })
  return {
    target: positionals[0],
    options: {
      version: values.version,
      packDir: values['pack-dir'],
      outputDir: values['output-dir'],
      delta: values.delta,
      iconPath: values.icon,
      signTemplate: values['sign-template'],
      identity: values.identity,
      entitlements: values.entitlements,
      notaryProfile: values['notary-profile'],
      keychain: values.keychain
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { target, options } = parsePackCli(process.argv.slice(2))
  const args = buildPackArgs(target, options)
  console.log(`vpk ${args.join(' ')}`)
  const result = spawnSync(process.env.VPK_BIN ?? 'vpk', args, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
