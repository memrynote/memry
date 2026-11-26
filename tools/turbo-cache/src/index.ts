// Turbo remote cache API (the subset turbo 2 calls) over R2. Two bearer tokens: READ_TOKEN may
// only read, WRITE_TOKEN may read and write. CI holds the write token only in the push-to-feat job,
// so a pull request or merge-group run can never put an artifact a later run replays.
// Artifacts are signed client-side (turbo's TURBO_REMOTE_CACHE_SIGNATURE_KEY); this Worker never
// holds that key. It stores the signature tag next to the artifact, refuses an unsigned upload, and
// turbo rejects a downloaded artifact whose tag does not verify.

export interface Env {
  CACHE: R2Bucket
  READ_TOKEN?: string
  WRITE_TOKEN?: string
}

type Access = 'read' | 'write'

// Shorter configured tokens are treated as unset, so a blank or placeholder secret never matches.
const MIN_TOKEN_LENGTH = 32
const ARTIFACT_PATH = /^\/v8\/artifacts\/([A-Za-z0-9]{1,128})$/
const TEAM = /^[A-Za-z0-9_-]{1,64}$/
// Workers hold a request in 128 MB of memory.
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// turbo parses the Vercel error shape and needs both fields.
const error = (status: number, code: string, message: string): Response =>
  json(status, { error: { code, message } })

function tokenMatches(presented: string, configured: string | undefined): boolean {
  if (!configured || configured.length < MIN_TOKEN_LENGTH) return false
  const a = new TextEncoder().encode(presented)
  const b = new TextEncoder().encode(configured)
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b)
}

function access(request: Request, env: Env): Access | null {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length)
  if (tokenMatches(token, env.WRITE_TOKEN)) return 'write'
  if (tokenMatches(token, env.READ_TOKEN)) return 'read'
  return null
}

function team(url: URL): string | null {
  const value = url.searchParams.get('slug') ?? url.searchParams.get('teamId')
  return value && TEAM.test(value) ? value : null
}

function artifactHeaders(object: R2Object): Headers {
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'content-length': String(object.size)
  })
  const { tag, duration } = object.customMetadata ?? {}
  if (tag) headers.set('x-artifact-tag', tag)
  if (duration) headers.set('x-artifact-duration', duration)
  return headers
}

async function putArtifact(request: Request, env: Env, key: string): Promise<Response> {
  const tag = request.headers.get('x-artifact-tag')
  if (!tag)
    return error(
      400,
      'unsigned',
      'unsigned artifact: set remoteCache.signature and the signature key'
    )
  // Buffered: R2 takes a stream only with a known length, and turbo may upload chunked. CI caches
  // only typecheck tasks, whose artifacts are logs of a few KB.
  if (Number(request.headers.get('content-length')) > MAX_ARTIFACT_BYTES) {
    return error(413, 'too_large', 'artifact too large')
  }
  const body = await request.arrayBuffer()
  if (body.byteLength === 0) return error(400, 'empty', 'empty artifact')
  if (body.byteLength > MAX_ARTIFACT_BYTES) return error(413, 'too_large', 'artifact too large')
  const duration = request.headers.get('x-artifact-duration') ?? '0'
  await env.CACHE.put(key, body, { customMetadata: { tag, duration } })
  return json(202, { urls: [] })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const granted = access(request, env)
    if (!granted) return error(401, 'unauthorized', 'missing or unknown token')

    if (url.pathname === '/v8/artifacts/status' && request.method === 'GET') {
      return json(200, { status: 'enabled' })
    }
    if (url.pathname === '/v8/artifacts/events' && request.method === 'POST') {
      return json(200, {})
    }

    const match = ARTIFACT_PATH.exec(url.pathname)
    if (!match) return error(404, 'not_found', 'not found')
    const slug = team(url)
    if (!slug) return error(400, 'bad_request', 'missing or invalid team')
    const key = `${slug}/${match[1]}`

    switch (request.method) {
      case 'GET': {
        const object = await env.CACHE.get(key)
        if (!object) return error(404, 'not_found', 'artifact not found')
        return new Response(object.body, { headers: artifactHeaders(object) })
      }
      case 'HEAD': {
        const object = await env.CACHE.head(key)
        if (!object) return error(404, 'not_found', 'artifact not found')
        return new Response(null, { headers: artifactHeaders(object) })
      }
      case 'PUT':
        if (granted !== 'write') return error(403, 'forbidden', 'this token is read-only')
        return putArtifact(request, env, key)
      default:
        return error(405, 'method_not_allowed', 'method not allowed')
    }
  }
} satisfies ExportedHandler<Env>
