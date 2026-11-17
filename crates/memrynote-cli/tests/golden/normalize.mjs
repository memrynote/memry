// The token expansion and output normalization of the golden scenarios. `tests/golden.rs` has the
// same rules in Rust; `normalize-cases.json` (written by generate.mjs from NORMALIZE_CASES) holds
// the two equal.

/** `{vault}`, `{home}`, `{tmp}` and each captured `{alias}` inside every string of `value`. */
export function expandTokens(value, dirs, aliases) {
  if (typeof value === 'string') {
    let out = value
    for (const [name, replacement] of [...Object.entries(dirs), ...Object.entries(aliases)]) {
      out = out.split(`{${name}}`).join(String(replacement))
    }
    return out
  }
  if (Array.isArray(value)) return value.map((item) => expandTokens(item, dirs, aliases))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandTokens(item, dirs, aliases)])
    )
  }
  return value
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g
const MS = /\b\d{13}\b/g

/** The folders of the run become `<vault>`, `<home>`, `<tmp>` (as written and as escaped inside
 *  JSON), ids `<idN>` by first appearance in `ids` (one map per scenario), ISO timestamps
 *  `<iso>`, 13-digit epoch milliseconds `<ms>`. */
export function normalize(text, dirs, ids = new Map()) {
  let out = text
  for (const [token, dir] of [
    ['<vault>', dirs.vault],
    ['<home>', dirs.home],
    ['<tmp>', dirs.tmp]
  ]) {
    out = out.split(JSON.stringify(dir).slice(1, -1)).join(token)
    out = out.split(dir).join(token)
  }
  out = out.replace(UUID, (id) => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`)
    return ids.get(id)
  })
  return out.replace(ISO, '<iso>').replace(MS, '<ms>')
}

export const NORMALIZE_CASES = [
  '{"path":"/tmp/x/vault/a","home":"/tmp/x/home/b","other":"/tmp/x/c","near":"/tmp/xy"}',
  '0f8fad5b-d9cb-469f-a165-70867728950e 7c9e6679-7425-40de-944b-e07fc1f90ae7 0f8fad5b-d9cb-469f-a165-70867728950e',
  '2026-01-02T03:04:05.678Z 2026-01-02T03:04:05Z 2026-01-02T03:04:05.678+03:00 2026-01-02',
  '1767225600000 12345678901234 123456789012 a1767225600000',
  'undefined\n\n'
]
