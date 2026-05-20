import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const expectedSequence = [
  ['01-waitlist-launch-plain.tsx', 'Wed May 20'],
  ['02-waitlist-scattered-workflow.tsx', 'Wed May 27'],
  ['03-waitlist-product-preview.tsx', 'Wed Jun 3'],
  ['04-waitlist-workflow.tsx', 'Wed Jun 10'],
  ['05-waitlist-local-first-ai.tsx', 'Wed Jun 17'],
  ['06-waitlist-launch-week.tsx', 'Wed Jun 24'],
  ['07-waitlist-launch-day.tsx', 'Tue Jun 30'],
  ['08-waitlist-getting-started.tsx', 'Thu Jul 2'],
  ['09-waitlist-use-cases.tsx', 'Tue Jul 7'],
  ['10-waitlist-feedback.tsx', 'Tue Jul 14'],
  ['11-waitlist-last-call.tsx', 'Tue Jul 21']
]

const forbiddenCopy = [
  /launch moved/i,
  /launch move/i,
  /changed date/i,
  /earlier than planned/i,
  /adjust dates if launch moves/i,
  /planned to open/i
]

const playbook = readFileSync(path.join(appDir, 'PLAYBOOK.md'), 'utf8')
const trackingLinks = readFileSync(path.join(appDir, 'src', 'tracking-links.ts'), 'utf8')
const sourceFiles = collectFiles(path.join(appDir, 'src'), /\.tsx?$/)
const checkedCopy = [
  playbook,
  readFileSync(path.join(appDir, 'README.md'), 'utf8'),
  ...sourceFiles.map((file) => readFileSync(file, 'utf8'))
].join('\n')

const failures = []

for (const [fileName, sendDate] of expectedSequence) {
  const emailPath = path.join(appDir, 'emails', fileName)
  if (!existsSync(emailPath)) {
    failures.push(`missing template ${fileName}`)
  }

  const playbookName = fileName.replace(/\.tsx$/, '')
  if (!playbook.includes(`\`${playbookName}\``)) {
    failures.push(`playbook missing ${playbookName}`)
  }

  if (!playbook.includes(sendDate)) {
    failures.push(`playbook missing send date ${sendDate}`)
  }
}

for (const pattern of forbiddenCopy) {
  if (pattern.test(checkedCopy)) {
    failures.push(`forbidden reactive copy matched ${pattern}`)
  }
}

if (!checkedCopy.includes('MemryNote ships end of June')) {
  failures.push('missing intentional end-of-June launch framing')
}

if (!checkedCopy.includes('25% off your first year on an annual plan')) {
  failures.push('missing waitlist annual discount framing')
}

for (let index = 1; index <= expectedSequence.length; index += 1) {
  const campaign = `waitlist_${String(index).padStart(2, '0')}`
  if (!trackingLinks.includes(`'${campaign}'`)) {
    failures.push(`missing tracked email campaign ${campaign}`)
  }
}

if (
  !trackingLinks.includes("'utm_source', 'waitlist'") ||
  !trackingLinks.includes("'utm_medium', 'email'")
) {
  failures.push('missing waitlist email UTM source/medium tracking')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}

function collectFiles(directory, pattern) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      return collectFiles(fullPath, pattern)
    }

    return pattern.test(entry.name) ? [fullPath] : []
  })
}
