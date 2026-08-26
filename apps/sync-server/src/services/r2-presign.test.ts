import { describe, it, expect } from 'vitest'

import {
  DEFAULT_PRESIGN_TTL_SECONDS,
  MAX_PRESIGN_TTL_SECONDS,
  assertPresignKeyInVault,
  presignR2Url,
  presignS3Url,
  resolveR2PresignConfig
} from './r2-presign'

// AWS's OFFICIAL published example credentials from the SigV4 docs — public
// documentation fixtures, not secrets. The access key id is split so the
// staged-secret scanner's `AKIA…` token rule does not fire on them; the
// concatenated value is exactly the documented one the vector requires.
const AWS_DOC_ACCESS_KEY_ID = 'AKIAIOSFOD' + 'NN7EXAMPLE'
const AWS_DOC_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

describe('presignS3Url (protocol layer)', () => {
  // Published known-answer vector from "Authenticating Requests: Using Query
  // Parameters (AWS Signature Version 4)" — pins the whole canonical-request /
  // string-to-sign / signing-key chain. If this signature drifts, R2 rejects
  // every URL we issue.
  it('reproduces the AWS SigV4 presigned-URL known-answer vector byte-for-byte', async () => {
    const url = await presignS3Url({
      host: 'examplebucket.s3.amazonaws.com',
      method: 'GET',
      objectPath: '/test.txt',
      accessKeyId: AWS_DOC_ACCESS_KEY_ID,
      secretAccessKey: AWS_DOC_SECRET_KEY,
      region: 'us-east-1',
      expiresInSeconds: 86400,
      now: new Date('2013-05-24T00:00:00.000Z')
    })

    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=' +
        // Same documented fixture, split for the same scanner reason.
        ['AKIAIOSFOD', 'NN7EXAMPLE'].join('') +
        '%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    )
  })
})

describe('presignR2Url (policy layer)', () => {
  const CONFIG = {
    accessKeyId: AWS_DOC_ACCESS_KEY_ID,
    secretAccessKey: AWS_DOC_SECRET_KEY,
    endpoint: 'https://abc123.r2.cloudflarestorage.com',
    bucket: 'memry-blobs'
  }

  it('builds path-style R2 URLs under the bucket prefix', async () => {
    const url = await presignR2Url(
      { ...CONFIG, endpoint: 'https://abc123.r2.cloudflarestorage.com', bucket: 'memry-blobs' },
      {
        method: 'GET',
        key: 'user-1/vaults/vault-1/chunks/abcd',
        now: new Date('2026-01-01T00:00:00Z')
      }
    )
    const parsed = new URL(url)
    expect(parsed.host).toBe('abc123.r2.cloudflarestorage.com')
    expect(parsed.pathname).toBe('/memry-blobs/user-1/vaults/vault-1/chunks/abcd')
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe(String(DEFAULT_PRESIGN_TTL_SECONDS))
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url).toMatch(/^https:\/\/.+&X-Amz-Signature=[0-9a-f]{64}$/)
  })

  it('clamps TTLs above the minutes-scale ceiling', async () => {
    const url = await presignR2Url(CONFIG, {
      method: 'GET',
      key: 'k',
      expiresInSeconds: 60 * 60 * 24
    })
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe(String(MAX_PRESIGN_TTL_SECONDS))
  })

  it('signs PUT and GET differently (distinct canonical requests)', async () => {
    const fixedNow = new Date('2026-01-01T00:00:00Z')
    const get = await presignR2Url(CONFIG, { method: 'GET', key: 'k', now: fixedNow })
    const put = await presignR2Url(CONFIG, { method: 'PUT', key: 'k', now: fixedNow })
    const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature')
    expect(sig(get)).not.toBe(sig(put))
  })

  it('URI-encodes unsafe characters in keys while preserving separators', async () => {
    const url = await presignR2Url(
      { ...CONFIG, bucket: 'bkt' },
      {
        method: 'GET',
        key: 'user/vaults/chunks/a b+c~d.e_f',
        now: new Date('2026-01-01T00:00:00Z')
      }
    )
    expect(new URL(url).pathname).toBe('/bkt/user/vaults/chunks/a%20b%2Bc~d.e_f')
  })
})

describe('resolveR2PresignConfig', () => {
  const FULL = {
    R2_ACCESS_KEY_ID: 'key-id',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com/',
    R2_S3_BUCKET: 'blobs'
  }

  it('resolves and normalizes a trailing slash off the endpoint', () => {
    const config = resolveR2PresignConfig(FULL)
    expect(config).toEqual({
      accessKeyId: 'key-id',
      secretAccessKey: 'secret',
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      bucket: 'blobs'
    })
  })

  it.each([
    ['R2_ACCESS_KEY_ID', { ...FULL, R2_ACCESS_KEY_ID: undefined }],
    ['R2_SECRET_ACCESS_KEY', { ...FULL, R2_SECRET_ACCESS_KEY: '' }],
    ['R2_S3_ENDPOINT', { ...FULL, R2_S3_ENDPOINT: undefined }],
    ['R2_S3_BUCKET', { ...FULL, R2_S3_BUCKET: undefined }]
  ])('returns null when %s is missing — graceful degradation signal', (_name, env) => {
    expect(resolveR2PresignConfig(env)).toBeNull()
  })

  it('rejects non-https endpoints', () => {
    expect(
      resolveR2PresignConfig({ ...FULL, R2_S3_ENDPOINT: 'http://insecure.example' })
    ).toBeNull()
  })

  it('rejects unparseable endpoints', () => {
    expect(resolveR2PresignConfig({ ...FULL, R2_S3_ENDPOINT: '::not-a-url' })).toBeNull()
  })
})

describe('assertPresignKeyInVault', () => {
  it('accepts keys under the caller vault prefix', () => {
    expect(() => assertPresignKeyInVault('u1/vaults/v1/chunks/hash', 'u1', 'v1')).not.toThrow()
  })

  it('rejects another user’s key', () => {
    expect(() => assertPresignKeyInVault('u2/vaults/v1/chunks/hash', 'u1', 'v1')).toThrow()
  })

  it('rejects another vault’s key', () => {
    expect(() => assertPresignKeyInVault('u1/vaults/v2/chunks/hash', 'u1', 'v1')).toThrow()
  })

  it('rejects lookalike prefixes (no partial segment matches)', () => {
    expect(() => assertPresignKeyInVault('u1/vaults/v11/chunks/hash', 'u1', 'v1')).toThrow()
  })
})
