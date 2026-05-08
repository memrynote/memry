import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const releaseDrafterWorkflow = readFileSync('.github/workflows/release-drafter.yml', 'utf8')
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')

describe('release flow workflows', () => {
  it('uses the Memry release name for draft and published releases', () => {
    assert.match(releaseDrafterWorkflow, /name:\s+\$\{\{\s*steps\.metadata\.outputs\.release_name\s*\}\}/)
    assert.match(releaseDrafterWorkflow, /RELEASE_NAME:\s+\$\{\{\s*steps\.metadata\.outputs\.release_name\s*\}\}/)
    assert.match(releaseDrafterWorkflow, /name:\s+releaseName/)

    assert.match(releaseWorkflow, /RELEASE_NAME:\s+\$\{\{\s*needs\.version\.outputs\.release_name\s*\}\}/)
    assert.match(releaseWorkflow, /-F name="\$RELEASE_NAME"/)
  })

  it('keeps release assets in the publish workflow only', () => {
    assert.doesNotMatch(releaseDrafterWorkflow, /release-assets|gh release upload|actions\/upload-artifact/)
    assert.match(releaseWorkflow, /Collect release assets/)
    assert.match(releaseWorkflow, /gh release upload "\$TAG" release-assets\/\* --clobber/)
  })
})
