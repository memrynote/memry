import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { validateAppVersion } from './desktop-release-metadata.mjs'

const [, , maybeFlag, maybeVersion] = process.argv

const validateOnly = maybeFlag === '--validate-only'
const version = validateOnly ? maybeVersion : maybeFlag

if (!version) {
  console.error('Usage: node scripts/set-desktop-version.mjs [--validate-only] <app-version>')
  process.exit(1)
}

validateAppVersion(version)

if (validateOnly) {
  console.log(version)
  process.exit(0)
}

const packageJsonPath = resolve('apps/desktop/package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

packageJson.version = version

writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

console.log(version)
