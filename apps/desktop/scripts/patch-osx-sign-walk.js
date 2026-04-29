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

    return Promise.all(
      entries.map(async (entry) => {
        const filePath = path.resolve(currentDir, entry)
        const stat = await fs.lstat(filePath)

        if (stat.isSymbolicLink()) {
          return null
        }

        if (stat.isFile()) {
          if (path.extname(filePath) === '.cstemp') {
            await fs.rm(filePath, { force: true })
            return null
          }

          return getFilePathIfBinary(filePath)
        }

        if (stat.isDirectory()) {
          const childPaths = await walk(filePath)

          switch (path.extname(filePath)) {
            case '.app':
            case '.framework':
              childPaths.push(filePath)
              break
          }

          return childPaths
        }

        return null
      })
    )
  }

  return osxSignUtil.compactFlattenedList(await walk(dirPath))
}

osxSignUtil.walkAsync = walkAsync
