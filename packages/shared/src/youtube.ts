export function extractYouTubeVideoId(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const hostname = parsed.hostname.toLowerCase()
  if (hostname === 'youtu.be') {
    return getValidVideoId(parsed.pathname.split('/').filter(Boolean)[0])
  }

  if (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com')) {
    return null
  }

  if (parsed.pathname === '/watch') {
    return getValidVideoId(parsed.searchParams.get('v'))
  }

  const [kind, videoId] = parsed.pathname.split('/').filter(Boolean)
  if (kind === 'embed' || kind === 'shorts') {
    return getValidVideoId(videoId)
  }

  return null
}

function getValidVideoId(value: string | null | undefined): string | null {
  if (!value || value.length !== 11) {
    return null
  }

  for (const char of value) {
    const code = char.charCodeAt(0)
    const isDigit = code >= 48 && code <= 57
    const isUpper = code >= 65 && code <= 90
    const isLower = code >= 97 && code <= 122
    if (!isDigit && !isUpper && !isLower && char !== '_' && char !== '-') {
      return null
    }
  }

  return value
}
