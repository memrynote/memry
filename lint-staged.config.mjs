import path from 'node:path'

const quote = (file) => JSON.stringify(path.resolve(file))
const quoteAll = (files) => files.map(quote).join(' ')
const withoutGeneratedLockfiles = (files) =>
  files.filter((file) => path.basename(file) !== 'pnpm-lock.yaml')

// Staged files get the fast tier: no type information, errors only. The type-aware
// ratchet (`pnpm lint`) runs in CI. Tasks run one after another (`--concurrent false`
// in .husky/pre-commit) so `oxlint --fix` and the formatter never write a file at once.
process.env.OXLINT_TYPE_AWARE = '0'

export default {
  '*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}': (files) =>
    `oxlint --fix --quiet --no-error-on-unmatched-pattern ${quoteAll(files)}`,
  '*.{ts,tsx,js,jsx,mjs,cjs,json,md,mdx,yml,yaml,css,html}': (files) => {
    const formatFiles = withoutGeneratedLockfiles(files)
    return formatFiles.length
      ? `pnpm exec oxfmt --no-error-on-unmatched-pattern ${quoteAll(formatFiles)}`
      : []
  }
}
