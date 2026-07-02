export const HUMANIZED_RELEASE_MARKER = 'memry-humanized-release-notes'

const requiredHumanizedSections = ['New Features', 'Improvements', 'Fixes']

function stripHtmlComments(text) {
  let output = ''
  let offset = 0

  while (offset < text.length) {
    const start = text.indexOf('<!--', offset)
    if (start === -1) {
      output += text.slice(offset)
      break
    }

    output += text.slice(offset, start)
    const end = text.indexOf('-->', start + 4)
    if (end === -1) {
      break
    }
    offset = end + 3
  }

  return output
}

export function extractPullRequestNumbers(body = '') {
  const seen = new Set()
  const numbers = []

  for (const line of body.split('\n')) {
    const number = extractPullRequestNumberFromLine(line)
    if (number === null || seen.has(number)) {
      continue
    }

    seen.add(number)
    numbers.push(number)
  }

  return numbers
}

function extractPullRequestNumberFromLine(line) {
  const trimmed = line.trim()

  // Deterministic changelog format: "#569 title @author".
  const leading = /^#(\d+)\b/.exec(trimmed)
  if (leading) {
    return Number(leading[1])
  }

  // release-drafter format: "- title (#issue) @author (#PR)". release-drafter
  // appends the PR number last, so the trailing "(#NNN)" is the PR; earlier
  // "(#NNN)" matches are issue references baked into the title.
  let pullRequestNumber = null
  for (const match of trimmed.matchAll(/\(#(\d+)\)/g)) {
    pullRequestNumber = Number(match[1])
  }

  return pullRequestNumber
}

export function extractReleaseNote(body = '') {
  const match = /^#{2,6}\s*Release note\s*\n([\s\S]*?)(?=\n#{2,6}\s|\s*$)/im.exec(body)
  if (!match) {
    return null
  }

  const note = stripHtmlComments(match[1]).trim()
  if (!note || /^(none|n\/a|na|no release note)$/i.test(note)) {
    return null
  }

  return note
}

export function buildHumanizedReleaseMarker(tag) {
  return `<!-- ${HUMANIZED_RELEASE_MARKER} tag=${tag} -->`
}

export function hasCurrentHumanizedReleaseNotes(body = '', expectedTag) {
  const marker = parseHumanizedReleaseMarker(body)
  return marker?.tag === expectedTag
}

export function assertHumanizedReleaseNotesForPublish({ body = '', draftTag, expectedTag }) {
  if (hasCurrentHumanizedReleaseNotes(body, expectedTag)) {
    return
  }

  const marker = parseHumanizedReleaseMarker(body)
  const reason = marker
    ? `Draft release notes were humanized for ${marker.tag}, but this publish resolves to ${expectedTag}.`
    : `Draft release notes have not been humanized for ${expectedTag}.`

  throw new Error(
    [
      reason,
      `Run: pnpm release:humanize -- --tag ${draftTag}`,
      'Review the draft release notes, then run pnpm release again.'
    ].join('\n')
  )
}

export function parseHumanizedReleaseMarker(body = '') {
  const markerPattern = new RegExp(`<!--\\s*${HUMANIZED_RELEASE_MARKER}\\s+tag=([^\\s>]+)\\s*-->`)
  const match = markerPattern.exec(body)

  return match ? { tag: match[1] } : null
}

export function extractPreviousTagFromReleaseBody(body = '') {
  const match = /\/compare\/(.+?)\.\.\.[^\s)]+/.exec(body)
  return match?.[1] ?? null
}

export function extractCompareBaseFromReleaseBody(body = '') {
  const match = /(https:\/\/github\.com\/[^\s)]+\/compare\/).+?\.\.\.[^\s)]+/.exec(body)
  return match?.[1] ?? null
}

export function buildCompareUrl({ compareBaseUrl, finalTag, previousTag }) {
  if (!compareBaseUrl || !previousTag || !finalTag) {
    throw new Error('compareBaseUrl, previousTag, and finalTag are required')
  }

  return `${compareBaseUrl}${previousTag}...${finalTag}`
}

export function validateHumanizedReleaseMarkdown(markdown = '') {
  const trimmed = markdown.trim()

  for (const section of requiredHumanizedSections) {
    const sectionPattern = new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'm')
    if (!sectionPattern.test(trimmed)) {
      throw new Error(`Humanized release notes must include a "${section}" section`)
    }
  }

  if (/^##\s+Changelog\s*$/im.test(trimmed)) {
    throw new Error('Humanized release notes must not include the Changelog section')
  }

  const contentLines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('## '))

  const nonBulletLines = contentLines.filter((line) => !line.startsWith('- '))
  if (nonBulletLines.length > 0) {
    throw new Error(
      `Humanized release note items must be Markdown bullets starting with "- ": ${nonBulletLines[0]}`
    )
  }

  const bulletLines = contentLines.filter((line) => line.startsWith('- '))
  for (const line of bulletLines) {
    if (/#\d+\b/.test(line)) {
      throw new Error(
        `Humanized release note bullet must not include a PR or issue number: ${line}`
      )
    }
  }

  return trimmed
}

export function buildChangelogSection({ compareUrl, pullRequests }) {
  if (!compareUrl) {
    throw new Error('compareUrl is required')
  }

  const lines = ['## Changelog', `Full Changelog: ${compareUrl}`, '']

  for (const pullRequest of pullRequests) {
    lines.push(
      `#${pullRequest.number} ${normalizeTitle(pullRequest.title)} @${normalizeAuthor(pullRequest.author)}`
    )
  }

  return lines.join('\n')
}

export function buildHumanizedReleaseBody({
  compareUrl,
  finalTag,
  humanizedMarkdown,
  pullRequests
}) {
  const humanized = validateHumanizedReleaseMarkdown(humanizedMarkdown)
  const changelog = buildChangelogSection({ compareUrl, pullRequests })

  return [buildHumanizedReleaseMarker(finalTag), humanized, changelog].join('\n\n') + '\n'
}

export function buildReleaseNotesPrompt({ finalTag, pullRequests }) {
  const input = {
    finalTag,
    pullRequests: pullRequests.map((pullRequest) => ({
      author: normalizeAuthor(pullRequest.author),
      labels: normalizeLabels(pullRequest.labels),
      number: pullRequest.number,
      releaseNote: pullRequest.releaseNote ?? null,
      title: normalizeTitle(pullRequest.title)
    }))
  }

  return [
    'You are writing Memry desktop release notes for end users.',
    '',
    'Audience: people using the Memry desktop app. They do not care about the',
    'marketing website, browser extension, internal refactors, or developer tooling.',
    '',
    'Rules:',
    '- Do not invent changes. Use only the provided PR titles, labels, authors, and release notes.',
    '- Include only changes that affect the desktop app or the sync experience for end users.',
    '- Judge relevance from each PR title scope and labels. Keep changes scoped to desktop, sync-server, or sync, plus cross-cutting user-facing features.',
    '- Skip changes scoped to the landing site, browser extension or web clipper, brand or rename, documentation, CI, tests, chores, and schema-only or internal refactors.',
    '- Do not include any PR numbers, issue numbers, or commit hashes.',
    '- Rewrite technical PR names into short human-friendly release-note bullets.',
    '- Keep each bullet to one sentence.',
    '- Every release-note item must be a Markdown bullet line starting with "- ".',
    '- Start every bullet with one relevant emoji, then a concise title, an em dash, and the explanation.',
    '- Use exactly these sections: ## New Features, ## Improvements, ## Fixes.',
    '- Leave a section empty if no provided change belongs there.',
    '- If no change is user-facing, keep all three headings and populate only "## Improvements" with a single bullet "- ✨ General improvements — performance and stability updates.", leaving "## New Features" and "## Fixes" with no bullets.',
    '- Do not include a Changelog section.',
    '- Return Markdown only. Do not wrap the answer in a code fence.',
    '- Begin the response with the "## New Features" heading. Add no greeting, preamble, or closing remarks.',
    '',
    'Input JSON:',
    JSON.stringify(input, null, 2)
  ].join('\n')
}

export function buildClaudeExecArgs({ model } = {}) {
  // Headless run with no setting sources so the local user/project CLAUDE.md,
  // skills, and hooks never load — conversational instructions (e.g. a greeting)
  // would otherwise contaminate the structured release-notes output.
  const args = ['-p', '--output-format', 'text', '--setting-sources', '']

  if (model) {
    args.push('--model', model)
  }

  return args
}

export function parseHumanizeReleaseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    model: undefined,
    tag: undefined,
    yes: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--') {
      continue
    }

    if (arg === '--tag') {
      options.tag = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }

    if (arg === '--model') {
      options.model = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('--model=')) {
      options.model = arg.slice('--model='.length)
      continue
    }

    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (arg === '--yes' || arg === '-y') {
      options.yes = true
      continue
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

export function normalizePullRequest(pullRequest) {
  return {
    author: normalizeAuthor(pullRequest.author),
    body: pullRequest.body ?? '',
    labels: normalizeLabels(pullRequest.labels),
    number: Number(pullRequest.number),
    releaseNote: pullRequest.releaseNote ?? extractReleaseNote(pullRequest.body ?? ''),
    title: normalizeTitle(pullRequest.title),
    url: pullRequest.url ?? null
  }
}

function normalizeAuthor(author) {
  if (typeof author === 'string') {
    return author.replace(/^@/, '')
  }

  return (author?.login ?? author?.name ?? 'unknown').replace(/^@/, '')
}

function normalizeLabels(labels = []) {
  return labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean)
    .map(String)
}

function normalizeTitle(title = '') {
  return String(title).replace(/\s+/g, ' ').trim()
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
