/**
 * The BlockNote converter off the main thread.
 *
 * Seeding a note from its file and turning a doc back into its file body both
 * load BlockNote and jsdom and walk the whole document. On main that blocked
 * the event loop for seconds on the first note open and the first edit after
 * launch, long enough for Windows to mark the window "Not Responding". Here
 * each job runs against a copy of the doc built from its state update, and asks
 * main only for what needs the vault: the note's current file and embed lookups.
 */
import { parentPort } from 'worker_threads'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { setCalloutTypeDefinitions } from '@memry/editor-schema/callout-types'
import * as converter from './blocknote-converter'
import { convertForWriteback } from './writeback-conversion'
import type {
  ConverterJob,
  ConverterJobResults,
  ConverterWorkerCall,
  FromConverterWorker,
  ToConverterWorker
} from './converter-worker-protocol'

if (!parentPort) {
  throw new Error('converter-worker.ts must be run as a worker_threads Worker')
}

const port = parentPort
const post = (message: FromConverterWorker): void => port.postMessage(message)

let nextCallId = 0
const calls = new Map<number, { resolve: (value: unknown) => void; reject: (e: Error) => void }>()

function callMain(call: ConverterWorkerCall): Promise<unknown> {
  const callId = ++nextCallId
  return new Promise((resolve, reject) => {
    calls.set(callId, { resolve, reject })
    post({ type: 'call', callId, ...call })
  })
}

converter.setVaultEmbedResolver(async (refs, notePath) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- main answers resolveEmbeds with resolveVaultEmbeds' return value
  return (await callMain({ op: 'resolveEmbeds', refs, notePath })) as Record<string, string>
})

async function run(
  jobId: number,
  job: ConverterJob,
  doc: Y.Doc
): Promise<ConverterJobResults[ConverterJob['kind']]> {
  if (job.kind === 'writeback') {
    return convertForWriteback(
      doc,
      job.notePath,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- main answers readFileBody with the file body or null
      async () => (await callMain({ op: 'readFileBody', jobId })) as string | null,
      converter
    )
  }
  // Only what the seed adds goes back, so main applies it over the same state
  // the seed read: the record and mark maps it replaces are replaced there too.
  const base = Y.encodeStateVector(doc)
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const ok = await converter.markdownToYFragment(job.markdown, fragment, job.notePath, job.writing)
  return ok ? Y.encodeStateAsUpdate(doc, base) : null
}

async function handle(message: Extract<ToConverterWorker, { type: 'job' }>): Promise<void> {
  try {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, message.update)
    setCalloutTypeDefinitions(message.calloutTypes)
    const result = await run(message.jobId, message.job, doc)
    post({ type: 'result', jobId: message.jobId, result })
  } catch (error) {
    post({
      type: 'failed',
      jobId: message.jobId,
      message: error instanceof Error ? (error.stack ?? error.message) : String(error)
    })
  }
}

port.on('message', (message: ToConverterWorker) => {
  if (message.type === 'job') {
    void handle(message)
    return
  }
  const pending = calls.get(message.callId)
  if (!pending) return
  calls.delete(message.callId)
  if (message.ok) pending.resolve(message.value)
  else pending.reject(new Error(message.message))
})

// The imports above are the expensive part (BlockNote, jsdom); they are done.
post({ type: 'ready' })
