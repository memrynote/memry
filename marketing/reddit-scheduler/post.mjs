#!/usr/bin/env node
// Reddit md-queue scheduler. No Reddit API — drives old.reddit.com with your real session.
// Usage:
//   node post.mjs --login     one-time: opens a browser, log in, session saved to ~/.reddit-scheduler-state.json
//   node post.mjs --dry-run   parse queue, print what would post when
//   node post.mjs             post everything whose post_at has passed (cron target)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ponytail: borrow playwright from apps/desktop instead of adding a dependency
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const { chromium } = require('@playwright/test')

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const QUEUE = path.join(ROOT, '..', 'reddit-queue')
const POSTED = path.join(QUEUE, 'posted')
const STATE = path.join(os.homedir(), '.reddit-scheduler-state.json')
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function parsePost(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) throw new Error(`${path.basename(file)}: missing frontmatter`)
  const meta = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  for (const key of ['title', 'subreddit', 'post_at'])
    if (!meta[key]) throw new Error(`${path.basename(file)}: missing "${key}" in frontmatter`)
  const at = new Date(meta.post_at) // "2026-07-08 09:00" = local time
  if (isNaN(at)) throw new Error(`${path.basename(file)}: bad post_at "${meta.post_at}"`)
  return { file, title: meta.title, subreddit: meta.subreddit, at, body: m[2].trim() }
}

function loadQueue() {
  return fs
    .readdirSync(QUEUE)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => parsePost(path.join(QUEUE, f)))
    .sort((a, b) => a.at - b.at)
}

async function login() {
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext({ userAgent: UA })
  const page = await ctx.newPage()
  await page.goto('https://old.reddit.com/login')
  console.log('Log in in the browser window. Waiting…')
  await page.waitForSelector('#header .user a[href*="/user/"]', { timeout: 300000 })
  await ctx.storageState({ path: STATE })
  await browser.close()
  console.log(`Session saved to ${STATE}`)
}

async function submit(page, post) {
  await page.goto(`https://old.reddit.com/r/${post.subreddit}/submit?selftext=true`)
  if (!(await page.$('#header .user a[href*="/user/"]')))
    throw new Error('Not logged in — run: node post.mjs --login')
  await page.fill('#newlink [name="title"]', post.title)
  await page.fill('#newlink [name="text"]', post.body)
  await Promise.all([
    page.waitForURL(/\/comments\//, { timeout: 30000 }),
    page.click('#newlink button[type="submit"]')
  ])
  return page.url()
}

async function run(dry) {
  const due = loadQueue().filter((p) => p.at <= new Date())
  if (dry) {
    for (const p of loadQueue())
      console.log(
        `${p.at <= new Date() ? 'DUE NOW ' : p.at.toLocaleString()}  r/${p.subreddit}  "${p.title}"  (${path.basename(p.file)})`
      )
    return
  }
  if (!due.length) return
  if (!fs.existsSync(STATE)) throw new Error('No session — run: node post.mjs --login')

  // ponytail: mkdir as lock; cron overlap is the only writer race that matters
  const lock = path.join(ROOT, '.lock')
  try {
    fs.mkdirSync(lock)
  } catch {
    console.log('Another run in progress, skipping.')
    return
  }
  const browser = await chromium.launch({ headless: true })
  try {
    const ctx = await browser.newContext({ userAgent: UA, storageState: STATE })
    const page = await ctx.newPage()
    for (const post of due) {
      const url = await submit(page, post)
      const dest = path.join(POSTED, path.basename(post.file))
      fs.appendFileSync(post.file, `\n\n<!-- posted: ${url} at ${new Date().toISOString()} -->\n`)
      fs.renameSync(post.file, dest)
      console.log(`Posted r/${post.subreddit} "${post.title}" -> ${url}`)
    }
  } finally {
    await browser.close()
    fs.rmdirSync(lock)
  }
}

const arg = process.argv[2]
if (arg === '--login') await login()
else await run(arg === '--dry-run')
