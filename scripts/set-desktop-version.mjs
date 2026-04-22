import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , maybeFlag, maybeVersion] = process.argv

const validateOnly = maybeFlag === '--validate-only'
const version = validateOnly ? maybeVersion : maybeFlag

if (!version) {
  console.error('Usage: node scripts/set-desktop-version.mjs [--validate-only] <calendar-version>')
  process.exit(1)
}

validateCalendarVersion(version)

if (validateOnly) {
  console.log(version)
  process.exit(0)
}

const packageJsonPath = resolve('apps/desktop/package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

packageJson.version = version

writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

console.log(version)

function validateCalendarVersion(input) {
  if (input.startsWith('v')) {
    throw new Error('Version must not include a v prefix')
  }

  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(input)
  if (!match) {
    throw new Error('Version must match YYYY.M.D')
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (month < 1 || month > 12) {
    throw new Error('Month must be between 1 and 12')
  }

  const candidate = new Date(Date.UTC(year, month - 1, day))
  const isValidDate =
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day

  if (!isValidDate) {
    throw new Error('Day is not valid for the given month/year')
  }
}
