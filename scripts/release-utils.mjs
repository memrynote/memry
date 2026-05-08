const defaultReleaseTimeZone = 'Europe/Istanbul'
const releaseListFields = ['tagName', 'name', 'isDraft', 'createdAt']

export function buildDateReleaseVersion({
  date = new Date(),
  existingTags = [],
  ignoreTag,
  timeZone = defaultReleaseTimeZone
} = {}) {
  const { year, month, day } = getDateParts(date, timeZone)
  const baseTag = `v${year}-${pad2(month)}-${pad2(day)}`
  const releaseIndex = nextReleaseIndex(baseTag, existingTags, ignoreTag)
  const tag = releaseIndex === 1 ? baseTag : `${baseTag}.${releaseIndex}`
  const monthDay = `${month}${pad2(day)}`

  return {
    appVersion: `${year}.${monthDay}.${releaseIndex}`,
    releaseIndex,
    releaseName: `Memry ${tag}`,
    tag
  }
}

export function selectDraftRelease(releases, tag) {
  if (tag) {
    const release = releases.find((candidate) => candidate.tagName === tag)
    if (!release) {
      throw new Error(`Release ${tag} was not found`)
    }

    if (!release.isDraft) {
      throw new Error(`Release ${tag} is not a draft`)
    }

    return release
  }

  const drafts = releases
    .filter((release) => release.isDraft)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())

  if (drafts.length === 0) {
    throw new Error('No draft release found')
  }

  return drafts[0]
}

export function parseReleaseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    tag: undefined,
    watch: true,
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

    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (arg === '--no-watch') {
      options.watch = false
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

export function getReleaseListFields() {
  return [...releaseListFields]
}

function getDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric'
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  )

  return {
    day: Number(parts.day),
    month: Number(parts.month),
    year: Number(parts.year)
  }
}

function nextReleaseIndex(baseTag, existingTags, ignoreTag) {
  const escapedBaseTag = escapeRegExp(baseTag)
  const tagPattern = new RegExp(`^${escapedBaseTag}(?:\\.(\\d+))?$`)
  let highestIndex = 0

  for (const tag of existingTags) {
    if (tag === ignoreTag) {
      continue
    }

    const match = tagPattern.exec(tag)
    if (!match) {
      continue
    }

    const index = match[1] ? Number(match[1]) : 1
    if (Number.isInteger(index) && index > highestIndex) {
      highestIndex = index
    }
  }

  return highestIndex + 1
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

function pad2(value) {
  return String(value).padStart(2, '0')
}
