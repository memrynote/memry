import { describe, expect, it } from 'vitest'

import { canonicalSceneJson, sceneFilesForWebview } from './canvas-file-urls'

const CANONICAL = 'memry-file://local/Users/k/v/attachments/c1/a%20b.png'
const WEBVIEW = 'https://memry-file.localhost/local/Users/k/v/attachments/c1/a%20b.png'

describe('sceneFilesForWebview', () => {
  it('rewrites a canonical image URL on Windows and leaves data URIs and other platforms alone', () => {
    const files = {
      a: { dataURL: CANONICAL, mimeType: 'image/png' },
      b: { dataURL: 'data:image/png;base64,AAAA' },
      c: undefined
    }
    expect(sceneFilesForWebview(files, 'win32')).toEqual({
      a: { dataURL: WEBVIEW, mimeType: 'image/png' },
      b: { dataURL: 'data:image/png;base64,AAAA' },
      c: undefined
    })
    expect(sceneFilesForWebview(files, 'darwin')).toEqual(files)
    expect(sceneFilesForWebview(undefined, 'win32')).toBeUndefined()
  })
})

describe('canonicalSceneJson', () => {
  it('puts the https form back to the canonical one', () => {
    const scene = JSON.stringify({ elements: [], files: { a: { dataURL: WEBVIEW } } })
    expect(JSON.parse(canonicalSceneJson(scene)).files.a.dataURL).toBe(CANONICAL)
  })

  it('drops the launch token with it: the token never reaches disk or sync', () => {
    const scene = JSON.stringify({ files: { a: { dataURL: `${WEBVIEW}?t=ab12cd` } } })
    expect(JSON.parse(canonicalSceneJson(scene)).files.a.dataURL).toBe(CANONICAL)
  })

  it('returns a scene with nothing to change as the same string', () => {
    const scene = JSON.stringify({ elements: [], files: { a: { dataURL: CANONICAL } } }, null, 2)
    expect(canonicalSceneJson(scene)).toBe(scene)
  })
})
