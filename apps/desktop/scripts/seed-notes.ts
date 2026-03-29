#!/usr/bin/env node --experimental-strip-types --experimental-transform-types

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import matter from 'gray-matter'
import { customAlphabet } from 'nanoid'
import { FOLDERS, NOTES } from './seed-notes-data.ts'

const generateNoteId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DEFAULT_TARGET = resolve(__dirname, '../dev-data/notes')

function randomPastDate(maxDaysAgo = 180): string {
  const now = Date.now()
  const offset = Math.random() * maxDaysAgo * 86_400_000
  return new Date(now - offset).toISOString()
}

function randomRecentDate(maxDaysAgo = 14): string {
  const now = Date.now()
  const offset = Math.random() * maxDaysAgo * 86_400_000
  return new Date(now - offset).toISOString()
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/(?:\r?\n)+$/g, '')
}

function serializeFolderConfig(config: Record<string, unknown>): string {
  return stripTrailingNewlines(matter.stringify('', config))
}

function serializeNote(frontmatter: Record<string, unknown>, body: string): string {
  return stripTrailingNewlines(matter.stringify(body.trim(), frontmatter))
}

function main(): void {
  const targetDir = process.argv[2] || DEFAULT_TARGET

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  console.log(`Seeding notes at: ${targetDir}`)

  let folderCount = 0
  for (const folder of FOLDERS) {
    const folderPath = resolve(targetDir, folder.name)
    if (!existsSync(folderPath)) {
      mkdirSync(folderPath, { recursive: true })
    }

    const configContent = serializeFolderConfig({
      icon: folder.icon,
      ...(Object.keys(folder.properties).length > 0 ? { properties: folder.properties } : {})
    })
    writeFileSync(resolve(folderPath, '.folder.md'), configContent, 'utf-8')
    folderCount++
  }

  console.log(`Created ${folderCount} folder configs`)

  let noteCount = 0
  for (const note of NOTES) {
    const frontmatter: Record<string, unknown> = {
      id: generateNoteId(),
      title: note.title,
      created: randomPastDate(),
      modified: randomRecentDate(),
      tags: note.tags
    }

    if (note.aliases) {
      frontmatter.aliases = note.aliases
    }
    if (note.emoji) {
      frontmatter.emoji = note.emoji
    }

    for (const [key, value] of Object.entries(note.properties)) {
      frontmatter[key] = value
    }

    const fileName = note.title.replace(/[/\\?%*:|"<>]/g, '-')
    const filePath = resolve(targetDir, note.folder, `${fileName}.md`)
    const content = serializeNote(frontmatter, note.body)

    writeFileSync(filePath, content, 'utf-8')
    noteCount++
  }

  console.log(`Created ${noteCount} notes across ${folderCount} folders`)
  console.log('Done!')
}

main()
