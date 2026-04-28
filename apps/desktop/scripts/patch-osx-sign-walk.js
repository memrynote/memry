const fs = require('node:fs/promises')
const { createRequire } = require('node:module')
const path = require('node:path')

const osxSignUtilPath = require.resolve('@electron/osx-sign/dist/cjs/util')
const osxSignRequire = createRequire(osxSignUtilPath)
const { isBinaryFile } = osxSignRequire('isbinaryfile')
const osxSignUtil = require(osxSignUtilPath)

async function getFilePathIfBinary(filePath) {
  if (await isBinaryFile(filePath)) {
    return filePath
  }

  return null
}

async function walkAsync(dirPath) {
  const signedPaths = []

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir)

    for (const entry of entries) {
      const filePath = path.resolve(currentDir, entry)
      const stat = await fs.lstat(filePath)

      if (stat.isSymbolicLink()) {
        continue
      }

      if (stat.isFile()) {
        if (path.extname(filePath) === '.cstemp') {
          await fs.rm(filePath, { force: true })
          continue
        }

        const binaryPath = await getFilePathIfBinary(filePath)
        if (binaryPath) {
          signedPaths.push(binaryPath)
        }

        continue
      }

      if (stat.isDirectory()) {
        await walk(filePath)

        switch (path.extname(filePath)) {
          case '.app':
          case '.framework':
            signedPaths.push(filePath)
            break
        }
      }
    }
  }

  await walk(dirPath)
  return signedPaths
}

osxSignUtil.walkAsync = walkAsync
