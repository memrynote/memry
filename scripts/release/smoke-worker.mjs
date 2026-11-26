#!/usr/bin/env node
// Starts the bundled memry-ml-worker against the bundled pdfium and opens one PDF, speaking the
// worker's frames (crates/memry-ml-worker/src/frame.rs, op.rs). On macOS this runs the signed
// worker under the hardened runtime, so library validation must accept the signed pdfium dylib.
// Usage: node scripts/release/smoke-worker.mjs <payload-dir> <windows|macos|linux> <pdf>
import { spawn } from 'node:child_process'
import path from 'node:path'

import { MANIFEST } from './assert-payload.mjs'

const PDF_OPEN = 0x01
const PDF_PAGE_TEXT = 0x02
const SHUTDOWN = 0x0f
const READY = 0x80
const PDF_OPENED = 0x81
const TEXT = 0x82
const FAILED = 0xff

function frame(op, id, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(9)
  head.writeUInt32BE(5 + payload.length, 0)
  head.writeUInt8(op, 4)
  head.writeUInt32BE(id, 5)
  return Buffer.concat([head, payload])
}

function u32s(...values) {
  const out = Buffer.alloc(4 * values.length)
  values.forEach((value, i) => out.writeUInt32BE(value, 4 * i))
  return out
}
const str = (value) => Buffer.concat([u32s(Buffer.byteLength(value)), Buffer.from(value)])

/** The worker's answers, in order: `{ op, id, payload }`. Each request is built from the answers so far. */
async function exchange(worker, args, requests) {
  // A worker that never answers is killed, so the job fails here instead of at its timeout.
  const child = spawn(worker, args, { stdio: ['pipe', 'pipe', 'inherit'], timeout: 120_000 })
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  const answers = []
  let buffered = Buffer.alloc(0)
  let next = 0
  child.stdout.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
      const len = buffered.readUInt32BE(0)
      const answer = {
        op: buffered.readUInt8(4),
        id: buffered.readUInt32BE(5),
        payload: buffered.subarray(9, 4 + len)
      }
      buffered = buffered.subarray(4 + len)
      answers.push(answer)
      if (next < requests.length) child.stdin.write(requests[next++](answers))
      else child.stdin.end()
    }
  })
  const { code, signal } = await exited
  if (code !== 0) throw new Error(`the worker exited with ${code ?? signal}`)
  return answers
}

function expectOp(answer, op, what) {
  if (answer?.op === op) return answer.payload
  const reason =
    answer?.op === FAILED
      ? answer.payload.subarray(4).toString()
      : `op 0x${answer?.op?.toString(16)}`
  throw new Error(`${what}: ${reason}`)
}

const [root, platform, pdf] = process.argv.slice(2)
const entry = MANIFEST.platforms[platform]
if (!root || !entry || !pdf) {
  console.error('usage: smoke-worker.mjs <payload-dir> <windows|macos|linux> <pdf>')
  process.exit(2)
}
const suffix = platform === 'windows' ? '.exe' : ''
const worker = path.resolve(root, entry.binDir, `memry-ml-worker${suffix}`)
const pdfium = path.resolve(root, entry.resourceDir, 'pdfium')
const docOf = (answers) => answers[1].payload.readUInt32BE(0)
const answers = await exchange(
  worker,
  ['--pdfium-dir', pdfium],
  [
    () => frame(PDF_OPEN, 1, str(path.resolve(pdf))),
    (got) => frame(PDF_PAGE_TEXT, 2, u32s(docOf(got), 1)),
    () => frame(SHUTDOWN, 3)
  ]
)
expectOp(answers[0], READY, 'ready')
const opened = expectOp(answers[1], PDF_OPENED, 'open the PDF')
const text = expectOp(answers[2], TEXT, 'page 1 text')
const pages = opened.readUInt32BE(4)
const chars = text.readUInt32BE(0)
if (pages < 1 || chars < 1) throw new Error(`opened ${pages} pages with ${chars} bytes of text`)
console.log(
  `worker ok: ${worker} opened ${path.basename(pdf)} (${pages} pages, page 1 ${chars} bytes of text)`
)
