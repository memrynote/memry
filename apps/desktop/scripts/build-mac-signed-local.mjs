import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = join(scriptDir, '..')
const envPath = join(appRoot, 'electron-builder.env')
const runtimeEnvPath = join(appRoot, '.env.staging')
const defaultSyncServerUrl = 'https://sync-staging.memrynote.com'

if (!existsSync(envPath)) {
  console.error('Missing apps/desktop/electron-builder.env')
  console.error(
    'Create it from apps/desktop/electron-builder.env.example and fill in local secrets.'
  )
  process.exit(1)
}

if (!existsSync(runtimeEnvPath)) {
  console.error('Missing apps/desktop/.env.staging')
  console.error('Create it before building; it is copied into the signed app as Resources/.env.')
  process.exit(1)
}

const parsedEnv = parse(readFileSync(envPath, 'utf8'))
const buildEnv = {
  ...process.env,
  ...parsedEnv,
  CSC_IDENTITY_AUTO_DISCOVERY:
    parsedEnv.CSC_IDENTITY_AUTO_DISCOVERY ?? process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'true',
  SYNC_SERVER_URL: parsedEnv.SYNC_SERVER_URL || process.env.SYNC_SERVER_URL || defaultSyncServerUrl
}

const requiredEnv = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID'
]
const missingEnv = requiredEnv.filter((key) => !buildEnv[key]?.trim())

if (missingEnv.length > 0) {
  console.error(`Missing required build secret(s): ${missingEnv.join(', ')}`)
  console.error('Fill them in apps/desktop/electron-builder.env and rerun.')
  process.exit(1)
}

const placeholderEnv = requiredEnv.filter((key) =>
  /absolute\/path|your-|xxxx-|TEAMID1234/.test(buildEnv[key] ?? '')
)

if (placeholderEnv.length > 0) {
  console.error(`Placeholder build secret(s) still present: ${placeholderEnv.join(', ')}`)
  console.error('Replace example values in apps/desktop/electron-builder.env and rerun.')
  process.exit(1)
}

if (buildEnv.CSC_IDENTITY_AUTO_DISCOVERY === 'false' && !buildEnv.CSC_NAME?.trim()) {
  console.error('CSC_IDENTITY_AUTO_DISCOVERY=false requires CSC_NAME for signed mac builds.')
  console.error('Without CSC_NAME, electron-builder falls back to ad-hoc signing on arm64.')
  console.error(
    'Set CSC_IDENTITY_AUTO_DISCOVERY=true or add CSC_NAME in apps/desktop/electron-builder.env.'
  )
  process.exit(1)
}

const cscLink = buildEnv.CSC_LINK.trim()
const cscLinkLooksLikeUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(cscLink)
if (!cscLinkLooksLikeUrl) {
  const certificatePath = isAbsolute(cscLink) ? cscLink : join(appRoot, cscLink)
  if (!existsSync(certificatePath)) {
    console.error(`CSC_LINK certificate file does not exist: ${certificatePath}`)
    process.exit(1)
  }
}

for (const key of [
  'ELECTRON_MIRROR',
  'ELECTRON_CUSTOM_DIR',
  'ELECTRON_BUILDER_BINARIES_MIRROR',
  'npm_config_electron_mirror',
  'npm_config_electron_builder_binaries_mirror',
  'electron_mirror',
  'electron_builder_binaries_mirror'
]) {
  delete buildEnv[key]
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env: buildEnv,
    stdio: 'inherit'
  })

  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

run('pnpm', ['build'])
run(process.execPath, [
  'scripts/build-packaged-app.js',
  '--config',
  'config/electron-builder.staged-local-mac.yml',
  '--mac',
  '--arm64',
  '--publish',
  'never'
])
