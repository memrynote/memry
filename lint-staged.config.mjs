import path from 'node:path'

const quote = (file) => JSON.stringify(path.resolve(file))
const quoteAll = (files) => files.map(quote).join(' ')
const withoutGeneratedLockfiles = (files) =>
  files.filter((file) => path.basename(file) !== 'pnpm-lock.yaml')

// Staged files get the fast tier: no type information, errors only, and no --fix. Some
// oxlint fixers change behavior or types (promise-function-async adds `async`, the
// no-unnecessary-type-assertion fixer widens inferred types), so fixes stay an explicit
// `pnpm lint:fix`. The type-aware ratchet (`pnpm lint`) runs in CI.
process.env.OXLINT_TYPE_AWARE = '0'

export default {
  '*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}': (files) =>
    `oxlint --quiet --no-error-on-unmatched-pattern ${quoteAll(files)}`,
  '*.{ts,tsx,js,jsx,mjs,cjs,json,md,mdx,yml,yaml,css,html}': (files) => {
    const formatFiles = withoutGeneratedLockfiles(files)
    return formatFiles.length
      ? `pnpm exec oxfmt --no-error-on-unmatched-pattern ${quoteAll(formatFiles)}`
      : []
  }
}
