// Matches bear://x-callback-url/open-note?... URLs, capturing the whole query
// string in one linear run. The link-text and query runs exclude `[` so they
// cannot overrun across repeated `[…](bear://…` anchors (ReDoS); the `id=`
// parameter is then pulled out of the captured query in JS rather than via a
// second ambiguous regex segment.
const BEAR_LINK_RE = /\[[^\][]*\]\(bear:\/\/x-callback-url\/open-note\?([^)[]*)\)/g
const ID_PARAM_RE = /\bid=([^&]+)/

export function rewriteBearLinks(body: string, idToTitle: Map<string, string>): string {
  return body.replace(BEAR_LINK_RE, (match, query: string) => {
    const id = ID_PARAM_RE.exec(query)?.[1]
    if (id == null) return match
    const title = idToTitle.get(id)
    if (title == null) return match
    return `[[${title}]]`
  })
}
