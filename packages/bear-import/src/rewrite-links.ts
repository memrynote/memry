// Matches bear://x-callback-url/open-note?... URLs, capturing the id= parameter
const BEAR_LINK_RE = /\[[^\]]*\]\(bear:\/\/x-callback-url\/open-note\?[^)]*\bid=([^&)]+)[^)]*\)/g

export function rewriteBearLinks(body: string, idToTitle: Map<string, string>): string {
  return body.replace(BEAR_LINK_RE, (match, id) => {
    const title = idToTitle.get(id)
    if (title == null) return match
    return `[[${title}]]`
  })
}
