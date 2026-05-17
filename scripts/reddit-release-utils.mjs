const defaultSubreddit = 'MemryNote'
const defaultTimeZone = 'Europe/Istanbul'

export function buildRedditReleasePost({
  appVersion,
  date = new Date(),
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
  const title = `Memry Update - ${titleVersion}`
  const releaseUrl = release?.url || `https://github.com/memrynote/memry/releases/tag/${tag}`
  const markdown = extractRedditReleaseMarkdown(release?.body ?? '')
  const text = [
    '🗞️ Release Notes',
    `📆 ${formatReleaseDate(date, timeZone)}`,
    '',
    markdown,
    '',
    `Release notes and downloads: ${releaseUrl}`
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

export function extractRedditReleaseMarkdown(body = '') {
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
      lines: section.lines.map(sanitizeReleaseLine).filter(Boolean)
    }))
    .filter((section) => section.lines.length > 0)

  if (populatedSections.length === 0) {
    throw new Error('Release body has no humanized release notes for Reddit')
  }

  return populatedSections
    .map((section) => [`## ${section.heading}`, '', ...section.lines].join('\n'))
    .join('\n\n')
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
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: '2-digit',
    hour12: true,
    minute: '2-digit',
    month: 'long',
    second: '2-digit',
    timeZone,
    year: 'numeric'
  }).format(date)
}
