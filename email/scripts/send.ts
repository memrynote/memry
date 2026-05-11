import { render } from '@react-email/render'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { Resend } from 'resend'

function loadDotEnv() {
  const envPath = resolve(import.meta.dirname, '..', '.env')
  if (!existsSync(envPath)) return
  const content = readFileSync(envPath, 'utf8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

loadDotEnv()

type Args = {
  slug: string
  to?: string
  audience: boolean
  sendNow: boolean
  exportOnly: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    slug: '',
    audience: false,
    sendNow: false,
    exportOnly: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--to') {
      args.to = argv[i + 1]
      i += 1
    } else if (arg === '--audience') {
      args.audience = true
    } else if (arg === '--send-now') {
      args.sendNow = true
    } else if (arg === '--export') {
      args.exportOnly = true
    } else if (!args.slug && !arg.startsWith('--')) {
      args.slug = arg
    }
  }
  return args
}

function usage(): never {
  console.error(`Usage:
  pnpm send <slug> --to <email>          # transactional test send
  pnpm send <slug> --audience            # create broadcast in Resend (dashboard sends)
  pnpm send <slug> --audience --send-now # create + send immediately (use with care)
  pnpm send <slug> --export              # render HTML to ./out/<slug>.html

Examples:
  pnpm send 01-introduction --to kaan@memry.app
  pnpm send 02-notes --audience
  pnpm send 11-launch-day --export
`)
  process.exit(1)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.slug) usage()

  const emailPath = resolve(import.meta.dirname, '..', 'emails', `${args.slug}.tsx`)
  if (!existsSync(emailPath)) {
    console.error(`No email found at ${emailPath}`)
    process.exit(1)
  }

  const mod = await import(pathToFileURL(emailPath).href)
  const Component = mod.default
  const subject: string | undefined = mod.subject
  if (!Component) {
    console.error(`Email ${args.slug} does not export a default component`)
    process.exit(1)
  }
  if (!subject && !args.exportOnly) {
    console.error(`Email ${args.slug} does not export a subject`)
    process.exit(1)
  }

  const element = createElement(Component)
  const html = await render(element)
  const text = await render(element, { plainText: true })

  if (args.exportOnly) {
    const outDir = resolve(import.meta.dirname, '..', 'out')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `${args.slug}.html`), html, 'utf8')
    writeFileSync(join(outDir, `${args.slug}.txt`), text, 'utf8')
    console.log(`Wrote ./out/${args.slug}.html and ./out/${args.slug}.txt`)
    return
  }

  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM
  const replyTo = process.env.RESEND_REPLY_TO
  if (!apiKey || !from) {
    console.error('Missing RESEND_API_KEY or RESEND_FROM in .env')
    process.exit(1)
  }
  const resend = new Resend(apiKey)

  if (args.to) {
    const result = await resend.emails.send({
      from,
      to: args.to,
      subject: subject!,
      html,
      text,
      replyTo
    })
    if (result.error) {
      console.error('Resend error:', result.error)
      process.exit(1)
    }
    console.log(`Sent ${args.slug} to ${args.to}. id=${result.data?.id}`)
    return
  }

  if (args.audience) {
    const audienceId = process.env.RESEND_AUDIENCE_ID
    if (!audienceId) {
      console.error('Missing RESEND_AUDIENCE_ID in .env')
      process.exit(1)
    }
    const created = await resend.broadcasts.create({
      audienceId,
      from,
      subject: subject!,
      html,
      name: `Memry Launch · ${args.slug}`,
      replyTo
    })
    if (created.error) {
      console.error('Broadcast create error:', created.error)
      process.exit(1)
    }
    const broadcastId = created.data?.id
    console.log(`Created broadcast ${broadcastId} for ${args.slug}`)
    if (args.sendNow && broadcastId) {
      const sent = await resend.broadcasts.send(broadcastId)
      if (sent.error) {
        console.error('Broadcast send error:', sent.error)
        process.exit(1)
      }
      console.log(`Broadcast ${broadcastId} sent.`)
    } else {
      console.log(`Open the Resend dashboard to review and send.`)
    }
    return
  }

  usage()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
