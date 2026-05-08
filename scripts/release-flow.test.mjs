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

  it('resolves draft releases from the releases list instead of releases by tag', () => {
    assert.doesNotMatch(releaseDrafterWorkflow, /\/releases\/tags\//)
    assert.doesNotMatch(releaseWorkflow, /\/releases\/tags\//)
  })

  it('keeps shell heredocs at column 0 inside workflow run blocks', () => {
    const lines = releaseWorkflow.split('\n')

    for (let index = 0; index < lines.length; index += 1) {
      const runMatch = lines[index].match(/^(\s*)run:\s*\|/)
      if (!runMatch) continue

      const baseIndent = `${runMatch[1]}  `
      const runLine = index + 1

      for (index += 1; index < lines.length; index += 1) {
        const line = lines[index]
        if (line.trim() !== '' && !line.startsWith(baseIndent)) {
          index -= 1
          break
        }

        const heredocMatch = line.match(/^(\s*).*<<'([A-Z_]+)'/)
        if (!heredocMatch) continue

        assert.equal(
          heredocMatch[1],
          baseIndent,
          `heredoc start in run block at line ${runLine} must be at shell column 0`
        )

        const terminator = `${baseIndent}${heredocMatch[2]}`
        const terminatorIndex = lines.findIndex(
          (candidate, candidateIndex) => candidateIndex > index && candidate === terminator
        )

        assert.notEqual(
          terminatorIndex,
          -1,
          `heredoc terminator ${heredocMatch[2]} after line ${index + 1} must be at shell column 0`
        )
      }
    }
  })
})
