/**
 * Generates `packages/contracts/test-vectors/embeddings-text.json`: the token ids and the stored
 * 256-value vectors transformers.js gives for 30 texts and 12 query and document pairs, which
 * `crates/memry-ml/tests/golden_text.rs` reproduces with the native engine.
 *
 *   pnpm embed:golden --model-dir <dir>            # write the file
 *   pnpm embed:golden --model-dir <dir> --check    # regenerate in memory, diff, write nothing
 *
 * `<dir>` (or `MEMRY_ML_MODEL_DIR`) is a `.../onnx-community/embeddinggemma-2-ONNX` folder that
 * holds the files of revision `MODEL_REVISION`, such as an Electron profile's
 * `models/transformers/onnx-community/embeddinggemma-2-ONNX`. Nothing is downloaded. The script is a
 * dev tool: no build runs it and CI does not run `--check`, because it needs the model.
 *
 * The oracle is Electron's text path (`apps/desktop/src/main/lib/embedding-worker.ts`), which
 * cannot be imported outside an Electron utility process, so each step is repeated here with its
 * source line: `handleEmbed` cuts the text to 4000 UTF-16 units, `loadEmbeddingPipeline` builds the
 * text-only model, `embed` tokenizes one text with `padding` and `truncation` and runs the model,
 * and `truncateEmbedding` keeps the first 256 values and divides them by their norm. The texts come
 * from `embedding-input.json`, the shaped inputs Electron's `embedding-input.ts` produces.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AutoConfig, AutoModel, AutoTokenizer, env } from '@huggingface/transformers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const VECTORS = join(ROOT, 'packages/contracts/test-vectors')
const OUT = join(VECTORS, 'embeddings-text.json')

const MODEL_REPO = 'onnx-community/embeddinggemma-2-ONNX'
const MODEL_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
/** The text group of `crates/memry-ml/src/files.rs`. */
const PINS = {
  'tokenizer.json': '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4',
  'onnx/model_q4.onnx': 'f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9',
  'onnx/model_q4.onnx_data': 'c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49'
}
/** Read by transformers.js but not by the native engine; their hashes are recorded. */
const UNPINNED = ['config.json', 'tokenizer_config.json']

/** `MAX_EMBEDDING_INPUT_LENGTH`, `EMBEDDING_DIMENSION`, `INFERENCE_THREADS` of the worker. */
const MAX_INPUT = 4000
const DIMENSION = 256
const THREADS = Math.min(2, Math.max(1, Math.floor(os.availableParallelism() / 2)))

/** Acceptance of #3540: the bounds `golden_text.rs` holds every vector to. */
const TOLERANCE = { minCosine: 0.9999, maxComponentDiff: 0.001 }

/**
 * Closest two documents may score for one query. A drift within the tolerance above could swap a
 * closer pair on another CPU, so the ranking texts are chosen to keep every gap above this.
 */
const MIN_RANK_GAP = 1e-4

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function modelDir() {
  const flag = process.argv.indexOf('--model-dir')
  const dir = flag === -1 ? process.env.MEMRY_ML_MODEL_DIR : process.argv[flag + 1]
  if (!dir) throw new Error('pass --model-dir <.../onnx-community/embeddinggemma-2-ONNX>')
  const abs = resolve(dir)
  if (!abs.split(/[\\/]/).join('/').endsWith(MODEL_REPO)) {
    throw new Error(`${abs} is not a ${MODEL_REPO} folder`)
  }
  for (const [file, pin] of Object.entries(PINS)) {
    if (sha256(join(abs, file)) !== pin) throw new Error(`${file} is not the pinned file`)
  }
  return abs
}

/**
 * The 30 golden texts, taken from `embedding-input.json` by case name: the 16 windows of a long
 * note, note documents and similarity inputs (English, Turkish, mixed, untitled, emoji, CJK, a
 * full 4000-unit window) and typed queries. Cases with a lone surrogate are skipped: the JSON
 * holds their well-formed form, not the string Electron embeds.
 */
function goldenTexts() {
  const input = JSON.parse(readFileSync(join(VECTORS, 'embedding-input.json'), 'utf8'))
  const byName = new Map(input.cases.map((item) => [item.name, item]))
  const pick = (name, field, index) => {
    const item = byName.get(name)
    if (!item || item.loneSurrogate) throw new Error(`embedding-input.json has no usable ${name}`)
    const value = index === undefined ? item.expected[field] : item.expected[field][index]
    if (typeof value !== 'string' || value === '') throw new Error(`${name} ${field} is empty`)
    return { name: `${name} / ${field}${index === undefined ? '' : ` ${index}`}`, text: value }
  }
  const windows = Array.from({ length: 16 }, (_, i) => pick('more than 16 windows', 'chunks', i))
  return [
    ...windows,
    pick('english title and body', 'document'),
    pick('english title and body', 'similarity'),
    pick('turkish title and body', 'document'),
    pick('turkish title and body', 'similarity'),
    pick('mixed languages', 'document'),
    pick('null title', 'document'),
    pick('emoji zwj sequences', 'document'),
    pick('cjk without spaces', 'document'),
    pick('turkish long', 'document'),
    pick('untitled long', 'similarity'),
    pick('one word', 'query'),
    pick('turkish', 'query'),
    pick('emoji', 'query'),
    pick('operators kept verbatim', 'query')
  ]
}

/**
 * Twelve topics, each a typed query and the note that answers it, in the forms of
 * `buildQueryEmbeddingInput` and `buildEmbeddingInput(..., 'document')`.
 */
const RANKING = [
  [
    'kedi bakımı',
    'Kedi bakımı',
    'Kedinin tüylerini haftada iki kez tara, suyunu her gün değiştir.'
  ],
  ['quarterly tax deadline', 'Taxes', 'The quarterly VAT return is due on the 26th of the month.'],
  ['sourdough starter', 'Baking', 'Feed the sourdough starter with flour and water every morning.'],
  ['deprem çantası', 'Deprem hazırlığı', 'Çantaya su, el feneri, düdük ve ilk yardım seti koy.'],
  ['rust borrow checker', 'Rust notes', 'A mutable borrow cannot coexist with a shared borrow.'],
  [
    'marathon training plan',
    'Running',
    'Long run on Sunday, intervals on Tuesday, rest on Friday.'
  ],
  ['istanbul trip itinerary', 'Trip', 'Day one Sultanahmet, day two a Bosphorus ferry to Kadıköy.'],
  ['tomato plants', 'Garden', 'Water the tomato seedlings at the roots and stake them early.'],
  ['piano lessons', 'Music', 'Practice scales slowly with a metronome before the sonata.'],
  ['database index', 'Postgres', 'A B-tree index speeds up lookups on the email column.'],
  ['doğum günü hediyesi', 'Annem', 'Annemin doğum günü için bir seramik vazo ve çiçek al.'],
  ['mortgage refinance', 'Home loan', 'Refinancing at a lower rate cuts the monthly payment.']
].map(([query, title, text]) => ({
  query: `task: search result | query: ${query}`,
  document: `title: ${title} | text: ${text}`
}))

async function loadModel(dir) {
  env.allowRemoteModels = false
  env.localModelPath = resolve(dir, '../..')
  // embedding-worker.ts loadEmbeddingPipeline: the text-only model.
  const config = await AutoConfig.from_pretrained(MODEL_REPO)
  config.vision_config = null
  config.audio_config = null
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(MODEL_REPO),
    AutoModel.from_pretrained(MODEL_REPO, {
      config,
      dtype: 'q4',
      device: 'cpu',
      session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 }
    })
  ])
  return { tokenizer, model }
}

/** embedding-worker.ts `truncateEmbedding`. */
function truncateEmbedding(full) {
  const out = new Float32Array(DIMENSION)
  let norm = 0
  for (let i = 0; i < DIMENSION; i++) {
    out[i] = full[i]
    norm += full[i] * full[i]
  }
  norm = Math.sqrt(norm)
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding is not finite')
  for (let i = 0; i < DIMENSION; i++) out[i] /= norm
  return out
}

/** `handleEmbed` and `embed`: the ids the model saw and the stored vector. */
async function embed({ tokenizer, model }, text) {
  const inputs = tokenizer([text.substring(0, MAX_INPUT)], { padding: true, truncation: true })
  const output = await model(inputs)
  const tokenIds = Array.from(inputs.input_ids.data, Number)
  return {
    tokenIds,
    // Nine significant digits give back the same f32.
    embedding: Array.from(truncateEmbedding(output.sentence_embedding.data), (value) =>
      Number(value.toPrecision(9))
    )
  }
}

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0)

async function render(dir) {
  const engine = await loadModel(dir)
  const texts = []
  for (const item of goldenTexts()) texts.push({ ...item, ...(await embed(engine, item.text)) })

  const queries = []
  const documents = []
  for (const pair of RANKING) {
    queries.push({ text: pair.query, ...(await embed(engine, pair.query)) })
    documents.push({ text: pair.document, ...(await embed(engine, pair.document)) })
  }
  let minGap = Infinity
  for (const query of queries) {
    const scores = documents.map((document) => dot(query.embedding, document.embedding))
    query.order = scores.map((_, i) => i).toSorted((a, b) => scores[b] - scores[a])
    for (let i = 1; i < query.order.length; i++) {
      minGap = Math.min(minGap, scores[query.order[i - 1]] - scores[query.order[i]])
    }
  }
  for (const [i, query] of queries.entries()) {
    if (query.order[0] !== i) throw new Error(`query ${i} does not rank its own note first`)
  }
  if (minGap < MIN_RANK_GAP) {
    throw new Error(`two documents score within ${minGap} for one query: change a ranking text`)
  }

  const document = {
    meta: {
      spec: 'tauri-v2-3540-embeddings-text',
      oracle:
        'crates/memry-ml/tests/golden/generate.mjs (the text path of Electron embedding-worker.ts on transformers.js)',
      transformers: JSON.parse(
        readFileSync(join(ROOT, 'node_modules/@huggingface/transformers/package.json'), 'utf8')
      ).version,
      model: { repo: MODEL_REPO, revision: MODEL_REVISION, dtype: 'q4' },
      unpinnedFiles: Object.fromEntries(UNPINNED.map((file) => [file, sha256(join(dir, file))])),
      note: 'tokenIds are the input_ids of tokenizer([text], { padding: true, truncation: true }) after the 4000-unit cut. embedding is the stored 256-value vector. ranking.queries[i].order lists document indices by descending cosine.',
      textCount: texts.length,
      rankingPairs: queries.length,
      rankingMinGap: Number(minGap.toPrecision(3)),
      rankingGapFloor: MIN_RANK_GAP
    },
    tolerance: TOLERANCE,
    texts,
    ranking: { queries, documents }
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

async function main() {
  const fresh = await render(modelDir())
  if (!process.argv.includes('--check')) {
    writeFileSync(OUT, fresh, 'utf8')
    process.stdout.write(`wrote ${OUT}\n`)
    return
  }
  let committed = ''
  try {
    committed = readFileSync(OUT, 'utf8')
  } catch {
    committed = ''
  }
  if (committed !== fresh) {
    process.stderr.write(`${basename(OUT)} is missing or regenerates differently.\n`)
    process.exit(1)
  }
  process.stdout.write(`${basename(OUT)} is current\n`)
}

await main()
