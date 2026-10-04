const fs = require('node:fs')
const path = require('node:path')

function findPackagedMacApps(appRoot, productName, hostArch = process.arch) {
  const distDir = path.join(appRoot, 'dist')
  if (!fs.existsSync(distDir)) {
    return []
  }

  const preferredDirs = [`mac-${hostArch}`, 'mac', 'mac-x64', 'mac-arm64']
  const discoveredDirs = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => entry.name)

  const dirNames = [...new Set([...preferredDirs, ...discoveredDirs])].filter((dirName) =>
    fs.existsSync(path.join(distDir, dirName))
  )

  return dirNames
    .map((dirName) => path.join(distDir, dirName, `${productName}.app`))
    .filter((appBundle) => fs.existsSync(appBundle))
}

function inferExpectedMacArch(appBundle, hostArch = process.arch) {
  const parentDir = path.basename(path.dirname(appBundle))
  const match = parentDir.match(/^mac-(.+)$/)
  return match?.[1] ?? hostArch
}

function normalizeMachOArch(arch) {
  if (arch === 'x86_64') return 'x64'
  return arch
}

function archListIncludes(archs, expectedArch) {
  return archs.map(normalizeMachOArch).includes(normalizeMachOArch(expectedArch))
}

/** Every symlink or junction under rootPath; links are reported, not followed. */
function findSymlinks(rootPath) {
  const links = []
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name)
    if (entry.isSymbolicLink()) links.push(entryPath)
    else if (entry.isDirectory()) links.push(...findSymlinks(entryPath))
  }
  return links
}

module.exports = {
  findPackagedMacApps,
  findSymlinks,
  inferExpectedMacArch,
  normalizeMachOArch,
  archListIncludes
}
