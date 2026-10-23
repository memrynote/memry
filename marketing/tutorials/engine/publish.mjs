// Uploads a topic's film to the memrynote YouTube channel, or updates the video it uploaded
// before. Run it only when Kaan asks; build.mjs never calls it.
//
//   node marketing/tutorials/engine/publish.mjs --auth [client_secret.json]  # sign in again
//   node marketing/tutorials/engine/publish.mjs <topic> --dry-run   # package, print, send nothing
//   node marketing/tutorials/engine/publish.mjs <topic>             # upload, or update the upload
//   node marketing/tutorials/engine/publish.mjs <topic> --video <id>  # take over a Studio upload
//
// It packages first, as the build's youtube step does, so the title, description and thumbnails
// match the current narration.json. Then it sends the videos.insert body youtube.mjs writes
// (private, not made for kids, no altered content), thumbnail 1, the SRT as English captions and
// the playlist entry. The chapters ride in the description. Kaan sets the visibility in Studio,
// along with the end screen and Test & compare, which have no API.
//
// ../youtube-ids.json keeps the IDs this script creates: playlists by channel.json key, videos by
// topic. A rerun updates the recorded video instead of uploading a second one. The update sends
// the whole snippet, because videos.update clears every snippet field it is not sent, and it
// leaves the status alone.
//
// Auth is a Desktop-app OAuth client (loopback redirect, PKCE) with the one scope
// youtube.force-ssl. The client and its refresh token stay in the macOS Keychain, so only the first
// sign-in needs the client's JSON. Every run checks that the token belongs to channel.json's
// channelId, so nothing lands on another channel.
import { execFileSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderThumbs } from './thumb.mjs'
import { IDS, buildMetadata, readIds } from './youtube.mjs'

const TUTORIALS = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3'
const TOKEN = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'
const KEYCHAIN = ['-s', 'memrynote-youtube', '-a', 'publish.mjs']
const CHUNK = 8 * 1024 * 1024 // a resumable upload's chunks are multiples of 256 KiB
const C = JSON.parse(fs.readFileSync(path.join(TUTORIALS, 'channel.json'), 'utf8'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mb = (file) => `${(fs.statSync(file).size / 1e6).toFixed(1)} MB`

/** An Error for a failed Google API response, carrying its HTTP status and Google's reason. */
async function googleError(res) {
  const text = await res.text()
  const e = text.startsWith('{') ? JSON.parse(text).error : undefined
  const reason = e?.errors?.[0]?.reason ?? ''
  const message = e?.message ?? text.slice(0, 300)
  const err = new Error(`${new URL(res.url).pathname}: HTTP ${res.status} ${reason} ${message}`)
  return Object.assign(err, { status: res.status, reason })
}

/** A caller for the Data API with one access token. */
function api(token) {
  return async (method, url, { json, body, type } = {}) => {
    const headers = { authorization: `Bearer ${token}` }
    if (json) {
      headers['content-type'] = 'application/json; charset=UTF-8'
      body = JSON.stringify(json)
    } else if (type) headers['content-type'] = type
    const res = await fetch(url, { method, headers, body })
    if (!res.ok) throw await googleError(res)
    return res.json()
  }
}

/** The client and refresh token --auth stored, or null before the first sign-in. */
function stored() {
  try {
    const raw = execFileSync('security', ['find-generic-password', ...KEYCHAIN, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return JSON.parse(raw)
  } catch (e) {
    if (e.status === 44) return null // security's exit code for "no such item"
    throw e
  }
}

async function accessToken() {
  const s = stored()
  if (!s) throw new Error('No YouTube sign-in yet. Run: publish.mjs --auth <client_secret.json>')
  const res = await fetch(TOKEN, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: s.client_id,
      client_secret: s.client_secret,
      refresh_token: s.refresh_token,
      grant_type: 'refresh_token'
    })
  })
  const t = await res.json()
  if (!res.ok)
    throw new Error(
      `Google refused the stored sign-in (${t.error}: ${t.error_description}). Run --auth again. ` +
        'An OAuth app left in Testing loses its tokens after 7 days.'
    )
  return t.access_token
}

/** The channel the token belongs to, which has to be channel.json's. */
async function ownChannel(call) {
  const url = `${API}/channels?part=snippet,status,contentDetails&mine=true`
  const ch = (await call('GET', url)).items?.[0]
  if (ch?.id !== C.channelId)
    throw new Error(
      `The sign-in belongs to ${ch ? `"${ch.snippet.title}" (${ch.id})` : 'no channel'}, ` +
        `not ${C.channelId}. Run --auth again and pick the MemryNote channel.`
    )
  return ch
}

async function signIn(clientFile) {
  // Google shows a client secret once, so after the first sign-in the Keychain is its only copy.
  const client = clientFile ? JSON.parse(fs.readFileSync(clientFile, 'utf8')).installed : stored()
  if (!client)
    throw new Error(
      clientFile
        ? `${clientFile} is not an OAuth client of type Desktop app`
        : 'No client in the Keychain yet. Run: publish.mjs --auth <client_secret.json>'
    )
  const verifier = crypto.randomBytes(48).toString('base64url')
  const state = crypto.randomBytes(16).toString('hex')
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const redirect = `http://127.0.0.1:${server.address().port}`
  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  consent.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'select_account consent'
  }).toString()
  const code = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams
      if (!q.has('code') && !q.has('error')) return void res.writeHead(404).end()
      const ok = q.get('state') === state && q.has('code')
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(ok ? 'Signed in. Close this tab.' : 'Sign-in failed. The terminal says why.')
      server.close()
      if (ok) resolve(q.get('code'))
      else
        reject(new Error(`Google sign-in failed: ${q.get('error') ?? 'the state did not match'}`))
    })
  })
  execFileSync('open', [consent.href])
  console.log(`Google sign-in is open in the browser. Pick the MemryNote channel.`)
  console.log(`No tab? Open ${consent.href}`)
  const res = await fetch(TOKEN, {
    method: 'POST',
    body: new URLSearchParams({
      code: await code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
      code_verifier: verifier
    })
  })
  const t = await res.json()
  if (!t.refresh_token)
    throw new Error(
      `Google sent no refresh token (${t.error ?? res.status}: ${t.error_description})`
    )
  const ch = await ownChannel(api(t.access_token))
  const secret = JSON.stringify({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: t.refresh_token
  })
  execFileSync('security', ['add-generic-password', '-U', ...KEYCHAIN, '-w', secret])
  console.log(`Signed in as ${ch.snippet.title} (${ch.id}). The token is in the Keychain.`)
  if (ch.status.longUploadsStatus !== 'allowed')
    console.log('Custom thumbnails need a phone-verified channel: https://www.youtube.com/verify')
}

/** A resumable videos.insert: open a session, then send 8 MB chunks, resuming after a drop. */
async function upload(token, file, body) {
  const size = fs.statSync(file).size
  const start = await fetch(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': String(size)
    },
    body: JSON.stringify(body)
  })
  if (!start.ok) throw await googleError(start)
  const session = start.headers.get('location')
  // Each PUT answers 308 with the bytes stored so far, or 200 with the video once it is whole.
  const put = (range, chunk) =>
    fetch(session, { method: 'PUT', headers: { 'content-range': range }, body: chunk }).catch(
      (e) => {
        console.log(`  upload: ${e.cause?.code ?? e.message}`)
        return null
      }
    )
  const fd = fs.openSync(file, 'r')
  try {
    let offset = 0
    let failures = 0
    for (;;) {
      const chunk = Buffer.alloc(Math.min(CHUNK, size - offset))
      fs.readSync(fd, chunk, 0, chunk.length, offset)
      let res = await put(`bytes ${offset}-${offset + chunk.length - 1}/${size}`, chunk)
      if (!res || res.status >= 500) {
        // A dropped connection or a server error: wait, then ask the session what it holds.
        if (++failures > 5) throw new Error(`The upload kept failing at byte ${offset} of ${size}`)
        await sleep(2 ** failures * 1000)
        res = await put(`bytes */${size}`, Buffer.alloc(0))
        if (!res || res.status >= 500) continue
      } else failures = 0
      if (res.ok) return res.json()
      if (res.status !== 308) throw await googleError(res)
      const range = res.headers.get('range')
      offset = range ? Number(range.split('-')[1]) + 1 : 0
      console.log(`  uploaded ${Math.round((offset / size) * 100)}%`)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** The ID of an upload with this title, so a lost youtube-ids.json entry cannot upload twice. */
async function uploadTitled(call, ch, title) {
  const list = ch.contentDetails.relatedPlaylists.uploads
  try {
    const url = `${API}/playlistItems?part=snippet&maxResults=50&playlistId=${list}`
    const { items = [] } = await call('GET', url)
    return items.find((i) => i.snippet.title === title)?.snippet.resourceId.videoId
  } catch (e) {
    if (e.status === 404) return undefined // a channel with no uploads has no uploads playlist
    throw e
  }
}

async function publish(topic, { dryRun, adopt }) {
  const dir = path.join(TUTORIALS, topic)
  const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
  if (!N.youtube) throw new Error(`${topic}/narration.json has no youtube block`)
  if (adopt && !/^[\w-]{11}$/.test(adopt)) throw new Error(`--video ${adopt}: not a video ID`)
  const file = (ext) => path.join(dir, 'out', `${topic}.${ext}`)
  for (const f of [file('mp4'), file('srt')])
    if (!fs.existsSync(f)) throw new Error(`Missing ${f}. Build the film first.`)
  buildMetadata(dir) // throws, before anything is sent, on metadata YouTube would reject
  const key = N.youtube.playlist
  const listTitle = C.playlists[key].title
  const ids = readIds()
  const save = () => {
    fs.writeFileSync(IDS, `${JSON.stringify(ids, null, 2)}\n`)
  }

  let call, ch
  const token = dryRun ? undefined : await accessToken()
  if (token) {
    call = api(token)
    ch = await ownChannel(call)
    if (!ids.playlists[key]) {
      const mine = await call('GET', `${API}/playlists?part=snippet&mine=true&maxResults=50`)
      const found = mine.items?.find((p) => p.snippet.title === listTitle)?.id
      ids.playlists[key] =
        found ??
        (
          await call('POST', `${API}/playlists?part=snippet,status`, {
            json: {
              snippet: { title: listTitle, defaultLanguage: 'en' },
              status: { privacyStatus: 'public' }
            }
          })
        ).id
      save()
      console.log(`  playlist ${listTitle} ${found ? 'found' : 'created'}: ${ids.playlists[key]}`)
    }
  }
  const meta = buildMetadata(dir) // again, so the description links the playlist
  const thumbs = await renderThumbs(dir)
  for (const w of [...meta.warnings, ...thumbs.warnings]) console.log(`  warning: ${w}`)
  const body = JSON.parse(fs.readFileSync(file('youtube.json'), 'utf8'))
  const known = adopt ?? ids.videos[topic]

  if (dryRun) {
    const s = body.status
    console.log(
      [
        `${topic}: dry run, nothing sent`,
        `  title        ${body.snippet.title} (${meta.titleChars}/100)`,
        `  description  ${meta.bytes} bytes, ${meta.chapters} chapters: ${file('description.txt')}`,
        `  tags         ${body.snippet.tags.join(', ')}`,
        `  status       ${s.privacyStatus}, made for kids ${s.selfDeclaredMadeForKids}, ` +
          `altered or synthetic ${s.containsSyntheticMedia}`,
        `  film         ${file('mp4')} (${mb(file('mp4'))})`,
        `  thumbnail    ${thumbs.files[0]} (${mb(thumbs.files[0])})`,
        `  captions     ${file('srt')}, English`,
        `  playlist     ${listTitle}: ${ids.playlists[key] ?? 'found by title or created first'}`,
        `  video        ${known ? `update ${known}` : 'new upload'}`,
        `  sign-in      ${stored() ? 'in the Keychain' : 'missing: run --auth <client_secret.json>'}`
      ].join('\n')
    )
    return
  }

  let id = known
  if (id) {
    const { items = [] } = await call('GET', `${API}/videos?part=snippet&id=${id}`)
    if (items[0]?.snippet.channelId !== ch.id)
      throw new Error(`Video ${id} is not on ${ch.snippet.title}. Check the ID in ${IDS}.`)
    await call('PUT', `${API}/videos?part=snippet`, { json: { id, snippet: body.snippet } })
    console.log(`  updated ${id}: title, description with the chapters, tags`)
  } else {
    const twin = await uploadTitled(call, ch, body.snippet.title)
    if (twin)
      throw new Error(
        `"${body.snippet.title}" is already on the channel as ${twin}. ` +
          `Run again with --video ${twin} to update that one.`
      )
    console.log(`  uploading ${file('mp4')} (${mb(file('mp4'))})`)
    id = (await upload(token, file('mp4'), body)).id
  }
  ids.videos[topic] = id
  save()

  try {
    await call('POST', `${UPLOAD}/thumbnails/set?uploadType=media&videoId=${id}`, {
      body: fs.readFileSync(thumbs.files[0]),
      type: 'image/jpeg'
    })
  } catch (e) {
    if (e.status === 403)
      e.message +=
        '\n  Custom thumbnails need a phone-verified channel: https://www.youtube.com/verify'
    throw e
  }
  console.log(`  thumbnail ${path.basename(thumbs.files[0])}`)

  const tracks = await call('GET', `${API}/captions?part=snippet&videoId=${id}`)
  const track = tracks.items?.find(
    (t) => t.snippet.trackKind === 'standard' && t.snippet.language === 'en'
  )
  const caption = track
    ? { id: track.id, snippet: { isDraft: false } }
    : { snippet: { videoId: id, language: 'en', name: '', isDraft: false } }
  const boundary = crypto.randomBytes(16).toString('hex')
  await call(track ? 'PUT' : 'POST', `${UPLOAD}/captions?uploadType=multipart&part=snippet`, {
    type: `multipart/related; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(caption)}\r\n--${boundary}\r\ncontent-type: text/plain\r\n\r\n`
      ),
      fs.readFileSync(file('srt')),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  })
  console.log(`  captions ${track ? 'replaced' : 'added'} from ${path.basename(file('srt'))}`)

  const playlistId = ids.playlists[key]
  const entry = `${API}/playlistItems?part=id&playlistId=${playlistId}&videoId=${id}`
  if (!(await call('GET', entry)).items?.length)
    await call('POST', `${API}/playlistItems?part=snippet`, {
      json: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: id } } }
    })
  console.log(`  in the ${listTitle} playlist`)

  console.log(
    [
      '',
      body.snippet.title,
      `  https://youtu.be/${id} (${known ? 'visibility unchanged' : 'private'})`,
      `  https://studio.youtube.com/video/${id}/edit`,
      'In Studio, by hand, since the API cannot:',
      '  1. End screen: Import from video. On the first video, a video element and Subscribe',
      '     side by side under the logo and URL, for the last 12 s.',
      `  2. Test & compare, optional: ${topic}.thumb-2.jpg and -3 beside thumb-1.`,
      '  3. Visibility: Public, or Schedule.'
    ].join('\n')
  )
}

const args = process.argv.slice(2)
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
if (args[0] === '--auth') await signIn(args[1])
else if (args[0] && !args[0].startsWith('-'))
  await publish(args[0], { dryRun: args.includes('--dry-run'), adopt: value('--video') })
else {
  console.error(
    'Usage: publish.mjs --auth [client_secret.json] | publish.mjs <topic> [--dry-run] [--video <id>]'
  )
  process.exit(1)
}
