#!/usr/bin/env node
// Builds a reproducible, self-contained source ZIP of the Memrynote Web Clipper
// for Firefox Add-ons (AMO) source-code review.
//
// Why a custom builder: WXT's own `--firefox-sources-zip` only captures files
// under apps/extension, so it drops the workspace dependency @memry/article-extract
// (and its @memry/typescript-config) — the sources then cannot be built. This
// bundles the extension + those two internal packages + the root manifests, with a
// trimmed pnpm-workspace.yaml so a reviewer runs a 3-package `pnpm install` (no
// Electron / native modules) and rebuilds `build:firefox` to match the submission.
//
// The tree is taken from HEAD (release builds tag HEAD), not the working copy.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const outDir = path.join(repoRoot, 'apps/extension/.output')
const outZip = path.join(outDir, 'firefox-review-sources.zip')

// Everything needed to build apps/extension in isolation.
const ROOT_FILES = ['package.json', 'pnpm-lock.yaml', '.npmrc', '.nvmrc']
const PACKAGE_DIRS = ['apps/extension', 'packages/article-extract', 'packages/typescript-config']

const TRIMMED_WORKSPACE_PACKAGES = `packages:\n${PACKAGE_DIRS.map((p) => `  - ${p}`).join('\n')}\n`

const REVIEW_MD = `# Building the Memrynote Web Clipper (Firefox) from source

Prerequisites: Node.js (version in \`.nvmrc\`) and pnpm 11 (\`corepack enable\`).

~~~sh
pnpm install --no-frozen-lockfile
pnpm --filter @memry/extension build:firefox
~~~

Build output: \`apps/extension/.output/firefox-mv3/\` — this matches the submitted
add-on.

Notes for reviewers:
- Only three workspace packages are included: the extension and the two internal
  libraries it imports (\`@memry/article-extract\`, \`@memry/typescript-config\`).
- \`--no-frozen-lockfile\` is required: the lockfile is shared with the full product
  monorepo, so installing this subset re-resolves it. Versions are pinned by the
  included \`pnpm-lock.yaml\` and \`pnpm-workspace.yaml\` \`overrides\`.
- No Electron or native modules are built.
`

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 })
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

const staging = mkdtempSync(path.join(tmpdir(), 'memry-ext-sources-'))
try {
  // 1. Extract the committed tree at HEAD into a staging dir.
  const tarPath = path.join(staging, '__src.tar')
  writeFileSync(tarPath, git(['archive', '--format=tar', 'HEAD', ...ROOT_FILES, ...PACKAGE_DIRS]))
  const src = path.join(staging, 'src')
  mkdirSync(src)
  run('tar', ['-xf', tarPath, '-C', src])
  rmSync(tarPath)

  // 2. Trimmed pnpm-workspace.yaml: narrow `packages:` to the three we ship and
  //    drop `patchedDependencies` (its patch file is intentionally excluded, and
  //    the patched package is not in the extension's dependency tree).
  let workspace = git(['show', 'HEAD:pnpm-workspace.yaml']).toString('utf8')
  const rewritten = workspace.replace(/^packages:\n(?:[ \t]+-.*\n)+/m, TRIMMED_WORKSPACE_PACKAGES)
  if (rewritten === workspace) {
    throw new Error(
      'build-extension-firefox-sources: could not rewrite `packages:` in pnpm-workspace.yaml'
    )
  }
  workspace = rewritten.replace(/\npatchedDependencies:\n(?:[ \t]+.*\n?)+/g, '\n')
  writeFileSync(path.join(src, 'pnpm-workspace.yaml'), workspace)

  // 3. Reviewer build instructions (AMO requires them for minified/bundled code).
  writeFileSync(path.join(src, 'SOURCE_CODE_REVIEW.md'), REVIEW_MD)

  // 4. Zip the staged tree.
  mkdirSync(outDir, { recursive: true })
  if (existsSync(outZip)) rmSync(outZip)
  run('zip', ['-r', '-q', '-X', outZip, '.'], src)
  console.log(`Firefox sources zip: ${path.relative(repoRoot, outZip)}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
