const defaultSubreddit = 'MemryNote'
const defaultTimeZone = 'Europe/Istanbul'

// Same preference order as apps/landing/api/download.ts: the signed Velopack
// installer wins over the unsigned electron-builder one.
const downloadTargets = [
  { label: 'macOS', matches: [(name) => name.endsWith('-arm64.dmg')] },
  {
    label: 'Windows',
    matches: [
      (name) => name === 'MemryNote-win-Setup.exe',
      (name) => name.toLowerCase().endsWith('-setup.exe')
    ]
  },
  { label: 'Linux', matches: [(name) => name.endsWith('.AppImage')] }
]

export function buildRedditReleasePost({
  appVersion,
  date = new Date(),
  intro,
  release,
  subreddit = defaultSubreddit,
  timeZone = defaultTimeZone
}) {
  const tag = release?.tagName

  if (!tag) {
    throw new Error('Release tag is required for Reddit post')
  }

  const resolvedAppVersion = appVersion || resolveReleaseAppVersion(tag)
  const titleVersion = resolvedAppVersion ? `${resolvedAppVersion} (${tag})` : tag
  const title = `MemryNote Desktop Update - ${titleVersion}`
  const releaseUrl = release?.url || `https://github.com/memrynote/memry/releases/tag/${tag}`
  const sections = extractRedditReleaseSections(release?.body ?? '')
  // Reddit's editor drops list items nested inside a blockquote, so the body is a
  // heading + paragraph + top-level list instead.
  const bullets = sections.flatMap((section) => section.lines).map((line) => `* ${line}`)
  const text = [
    `## 📆 ${formatReleaseDate(date, timeZone)}`,
    '',
    intro || buildIntroLine(resolvedAppVersion || tag, sections),
    '',
    ...bullets,
    '',
    '---',
    '',
    buildLinkLine(releaseUrl, release?.assets ?? [])
  ].join('\n')

  if (title.length > 300) {
    throw new Error('Reddit release post title must be 300 characters or less')
  }

  return {
    subreddit,
    text,
    title
  }
}

export function formatRedditCopyPastePost(post) {
  return [
    'Subreddit:',
    `r/${post.subreddit}`,
    '',
    'Title:',
    post.title,
    '',
    'Body:',
    post.text
  ].join('\n')
}

export function resolveReleaseAppVersion(tag) {
  const match = /^v(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?$/.exec(tag)
  if (!match) {
    return null
  }

  const [, year, month, day, releaseIndex = '1'] = match
  return `${year}.${Number(month)}${day}.${releaseIndex}`
}

export function buildIntroLine(version, sections) {
  const counts = sections.map((section) => {
    const count = section.lines.length
    const noun = sectionNoun(section.heading, count)
    return `${count} ${noun}`
  })

  return `MemryNote **${version}** ships ${joinList(counts)}.`
}

export function buildLinkLine(releaseUrl, assets = []) {
  const links = [`[Release Notes](${releaseUrl})`]

  for (const target of downloadTargets) {
    const asset = findAsset(assets, target.matches)
    if (asset) {
      links.push(`[${target.label}](${asset.url}) (${formatAssetSize(asset.size)})`)
    }
  }

  return links.join(' – ')
}

function findAsset(assets, matchers) {
  for (const match of matchers) {
    const asset = assets.find((candidate) => candidate?.name && match(candidate.name))
    if (asset?.url) {
      return asset
    }
  }

  return null
}

function formatAssetSize(size) {
  return `${(Number(size || 0) / 1024 / 1024).toFixed(2)} MiB`
}

function sectionNoun(heading, count) {
  const normalized = heading.toLowerCase()

  if (normalized.includes('feature')) {
    return count === 1 ? 'new feature' : 'new features'
  }

  if (normalized.includes('fix')) {
    return count === 1 ? 'fix' : 'fixes'
  }

  if (normalized.includes('improvement')) {
    return count === 1 ? 'improvement' : 'improvements'
  }

  return count === 1 ? normalized.replace(/s$/, '') : normalized
}

function joinList(items) {
  if (items.length <= 1) {
    return items.join('')
  }

  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

export function extractRedditReleaseSections(body = '') {
  const bodyWithoutMarker = body
    .replace(/<!--\s*memry-humanized-release-notes\s+tag=[^\s>]+\s*-->/, '')
    .trim()
  const changelogMatch = /^##\s+Changelog\s*$/im.exec(bodyWithoutMarker)
  const humanizedMarkdown = changelogMatch
    ? bodyWithoutMarker.slice(0, changelogMatch.index).trim()
    : bodyWithoutMarker
  const sections = parseSections(humanizedMarkdown)
  const populatedSections = sections
    .map((section) => ({
      heading: section.heading,
      lines: section.lines.map(formatReleaseBullet).filter(Boolean)
    }))
    .filter((section) => section.lines.length > 0)

  if (populatedSections.length === 0) {
    throw new Error('Release body has no humanized release notes for Reddit')
  }

  return populatedSections.sort((a, b) => sectionRank(a.heading) - sectionRank(b.heading))
}

// Features first, then improvements, then fixes; anything else keeps to the end.
function sectionRank(heading) {
  const normalized = heading.toLowerCase()

  if (normalized.includes('feature')) return 0
  if (normalized.includes('improvement')) return 1
  if (normalized.includes('fix')) return 2
  return 3
}

// `- 📂 Title — description` becomes `📂 **Title**. Description.`
function formatReleaseBullet(line) {
  const text = sanitizeReleaseLine(line).replace(/^[-*]\s+/, '')

  if (!text) {
    return null
  }

  const [, emoji = '', rest] = /^((?:\p{Extended_Pictographic}\uFE0F?)+\s+)?([\s\S]*)$/u.exec(text)
  const split = /^(.*?)\s+[—–]\s+([\s\S]+)$/.exec(rest)

  if (!split) {
    return `${emoji}${endWithPeriod(rest)}`
  }

  return `${emoji}**${split[1]}**. ${endWithPeriod(capitalize(split[2]))}`
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function endWithPeriod(value) {
  return /[.!?]$/.test(value) ? value : `${value}.`
}

function parseSections(markdown) {
  const sections = []
  let currentSection = null

  for (const line of markdown.split('\n')) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line.trim())

    if (headingMatch) {
      currentSection = {
        heading: headingMatch[1],
        lines: []
      }
      sections.push(currentSection)
      continue
    }

    if (!currentSection) {
      continue
    }

    currentSection.lines.push(line)
  }

  return sections
}

function sanitizeReleaseLine(line) {
  return line
    .trim()
    .replace(/\s*\((?:#\d+\b(?:,\s*)?)+\)/g, '')
    .trim()
}

function formatReleaseDate(date, timeZone) {
  const day = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone,
    year: 'numeric'
  }).format(date)
  const time = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: true,
    minute: '2-digit',
    second: '2-digit',
    timeZone
  }).format(date)

  return `${day} at ${time}`
}
