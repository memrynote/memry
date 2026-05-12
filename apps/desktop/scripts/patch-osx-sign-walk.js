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
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir)
    const paths = []

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
          paths.push(binaryPath)
        }
        continue
      }

      if (stat.isDirectory()) {
        const childPaths = await walk(filePath)

        switch (path.extname(filePath)) {
          case '.app':
          case '.framework':
            childPaths.push(filePath)
            break
        }

        paths.push(childPaths)
      }
    }

    return paths
  }

  return osxSignUtil.compactFlattenedList(await walk(dirPath))
}

osxSignUtil.walkAsync = walkAsync
