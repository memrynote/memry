#!/usr/bin/env node
/**
 * The Tauri renderer makes no request to a memry host.
 *
 * The certificate pins live in the Rust transport (`crates/memry-desktop/src/seams/tls`); a
 * webview request to the sync server would skip them, and the webview has no pin of its own
 * (Electron pinned its renderer session, `apps/desktop/src/main/index.ts:655-689`). So every
 * sync, telemetry and feedback request goes through a Tauri command. The enforcement is the CSP:
 * `connect-src` in `apps/desktop-tauri/src-tauri/tauri.conf.json` names no memrynote.com host, so
 * the webview refuses such a request. This gate is the backstop that names the offending line
 * before a reviewer has to find it, and it fails when a renderer source file calls `fetch`,
 * `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` with a memrynote.com URL, a
 * constant of the file that holds one, or the sync server URL. Links the user opens
 * (`window.open`, `href`) are not requests and are not flagged.
 *
 *   node scripts/check-renderer-no-sync-host.mjs
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = join(repoRoot, 'apps/desktop-tauri/src/renderer/src')

/** `file:line` entries allowed to request a memry host, each with the reason. None today. */
const ALLOWED = new Map()

const SOURCE = /\.[cm]?[jt]sx?$/
const TEST = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/
const MEMRY_HOST = /memrynote\.com/i
const SYNC_URL_NAMES =
  /\b(?:SYNC_SERVER_URL|VITE_SYNC_SERVER_URL|syncServerUrl|getSyncServerUrl|sync_server_url)\b/
/** The start of a call that sends a request; the argument list follows the `(`. */
const REQUEST_CALL =
  /\b(?:fetch|new\s+WebSocket|new\s+EventSource|navigator\s*\.\s*sendBeacon|\.open)\s*\(/g
const XHR = /\bXMLHttpRequest\b/

/**
 * Comments replaced by spaces, so offsets and line numbers stay put. A scan that knows strings:
 * `'image/*'` or `'https://x'` is a string, not the start of a comment. Template literals are
 * taken whole; a regex literal holding `//` or a quote is the one shape it can misread, and none
 * appears in a request call.
 */
function stripComments(text) {
  const out = text.split('')
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n') out[index] = ' '
    }
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === "'" || char === '"' || char === '`') {
      index += 1
      while (index < text.length && text[index] !== char) {
        if (char !== '`' && text[index] === '\n') break
        index += text[index] === '\\' ? 2 : 1
      }
      index += 1
    } else if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index)
      const stop = end === -1 ? text.length : end
      blank(index, stop)
      index = stop
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      const stop = end === -1 ? text.length : end + 2
      blank(index, stop)
      index = stop
    } else {
      index += 1
    }
  }
  return out.join('')
}

/** The text of the argument list that opens at `open` (the index of its `(`). */
function argumentsAt(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, index)
    }
  }
  return text.slice(open + 1)
}

/** Names the file binds to a string that holds a memry host: `const X = 'https://…memrynote.com…'`. */
function memryHostNames(text) {
  const names = new Set()
  const binding = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`]*)\2/g
  for (const match of text.matchAll(binding)) {
    if (MEMRY_HOST.test(match[3])) names.add(match[1])
  }
  return names
}

/** Each request in `text` aimed at a memry host or the sync server: `{ line, call }`. */
export function findSyncHostRequests(text) {
  const code = stripComments(text)
  const names = memryHostNames(code)
  const namesPattern = names.size > 0 ? new RegExp(`\\b(?:${[...names].join('|')})\\b`) : null
  const usesXhr = XHR.test(code)
  const found = []
  for (const match of code.matchAll(REQUEST_CALL)) {
    if (match[0].startsWith('.open') && !usesXhr) continue
    const open = match.index + match[0].length - 1
    const args = argumentsAt(code, open)
    if (MEMRY_HOST.test(args) || SYNC_URL_NAMES.test(args) || namesPattern?.test(args)) {
      const line = code.slice(0, match.index).split('\n').length
      found.push({ line, call: `${match[0]}${args.split('\n')[0]}`.trim() })
    }
  }
  return found
}

async function sourceFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...(await sourceFiles(full)))
    } else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

async function main() {
  const files = await sourceFiles(rendererRoot)
  const offenders = []
  for (const file of files) {
    const path = relative(repoRoot, file).split(sep).join('/')
    for (const { line, call } of findSyncHostRequests(await readFile(file, 'utf8'))) {
      if (!ALLOWED.has(`${path}:${line}`)) offenders.push(`${path}:${line}: ${call}`)
    }
  }
  if (offenders.length > 0) {
    console.error(
      'The renderer requests a memry host directly, which skips the certificate pins. ' +
        'Send it through a Tauri command (the Rust transport) instead:\n' +
        offenders.join('\n')
    )
    process.exit(1)
  }
  console.log(`Renderer sync-host check passed (${files.length} files)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
