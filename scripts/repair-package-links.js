#!/usr/bin/env node

const fs = require('node:fs/promises')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const pnpmStoreRoot = path.join(repoRoot, 'node_modules', '.pnpm')
const pnpmStoreMarker = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`

async function collectSymlinks(dir) {
  const links = []
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.name === '.bin') {
      continue
    }

    const entryPath = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(entryPath)
      continue
    }

    if (entry.isDirectory() && entry.name.startsWith('@')) {
      links.push(...(await collectSymlinks(entryPath)))
    }
  }

  return links
}

function resolveStoreSuffix(targetPath) {
  const normalized = targetPath.split(path.posix.sep).join(path.sep)
  const markerIndex = normalized.lastIndexOf(pnpmStoreMarker)
  if (markerIndex === -1) {
    return null
  }

  return normalized.slice(markerIndex + pnpmStoreMarker.length)
}

async function repairSymlink(linkPath) {
  try {
    await fs.access(linkPath)
    return false
  } catch {}

  const currentTarget = await fs.readlink(linkPath)
  const suffix = resolveStoreSuffix(currentTarget)
  if (!suffix) {
    return false
  }

  const nextTarget = path.join(pnpmStoreRoot, suffix)
  try {
    await fs.access(nextTarget)
  } catch {
    return false
  }

  await fs.rm(linkPath, { force: true, recursive: true })
  await fs.symlink(path.relative(path.dirname(linkPath), nextTarget), linkPath)
  return true
}

async function main() {
  const [workspacePath] = process.argv.slice(2)
  if (!workspacePath) {
    console.error('Usage: node scripts/repair-package-links.js <workspace-path>')
    process.exit(1)
  }

  const nodeModulesPath = path.join(repoRoot, workspacePath, 'node_modules')
  const links = await collectSymlinks(nodeModulesPath)
  let repairedCount = 0

  for (const linkPath of links) {
    if (await repairSymlink(linkPath)) {
      repairedCount += 1
    }
  }

  if (repairedCount > 0) {
    console.log(`Repaired ${repairedCount} package links in ${workspacePath}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
