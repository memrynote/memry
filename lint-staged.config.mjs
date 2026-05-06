import path from 'node:path'

const quote = (file) => JSON.stringify(path.resolve(file))
const quoteAll = (files) => files.map(quote).join(' ')
const withoutGeneratedLockfiles = (files) =>
  files.filter((file) => path.basename(file) !== 'pnpm-lock.yaml')

export default {
  '*.{ts,tsx,js,jsx,mjs,cjs,json,md,mdx,yml,yaml,css,html}': (files) => {
    const formatFiles = withoutGeneratedLockfiles(files)
    return formatFiles.length
      ? `pnpm exec prettier --write --ignore-unknown ${quoteAll(formatFiles)}`
      : []
  }
}
