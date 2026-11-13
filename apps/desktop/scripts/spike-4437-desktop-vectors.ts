/**
 * Throwaway #4437 spike: the 20 parity inputs, shaped by desktop's own
 * `embedding-input.ts`, and their desktop vectors from transformers.js loaded
 * exactly as `embedding-worker.ts` loads it (text-only config, q4, CPU, two
 * intra-op threads, `sentence_embedding`, Matryoshka truncation to 256).
 *
 *   MODEL_CACHE=<dir holding onnx-community/embeddinggemma-2-ONNX> \
 *     npx tsx scripts/spike-4437-desktop-vectors.ts <out-dir>
 *
 * Writes `parity-inputs.json` (copied to the phone) and `desktop-vectors.json`.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AutoConfig, AutoModel, AutoTokenizer, env } from '@huggingface/transformers'
import {
  buildEmbeddingChunks,
  buildEmbeddingInput,
  buildQueryEmbeddingInput,
  MAX_EMBEDDING_INPUT_LENGTH
} from '../src/main/lib/embedding-input'
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_DTYPE,
  EMBEDDING_MODEL_REPO
} from '../src/main/lib/embeddings-constants'

const outDir = process.argv[2] ?? '.'
const cache = process.env.MODEL_CACHE
if (!cache) throw new Error('MODEL_CACHE is required')

const paragraph =
  'The quarterly planning meeting covered the budget for the design system, the hiring plan ' +
  'for two engineers, and the release schedule for the sync server. Action items: Ayse drafts ' +
  'the onboarding doc, Mehmet reviews the invoice from the contractor, and we revisit the ' +
  'metrics dashboard next Tuesday.\n\n'
const longBody = paragraph.repeat(60)

const inputs: Array<{ id: string; text: string }> = [
  { id: 'q-en-short', text: buildQueryEmbeddingInput('budget meeting') },
  { id: 'q-en-sentence', text: buildQueryEmbeddingInput('what did we decide about hiring?') },
  { id: 'q-tr', text: buildQueryEmbeddingInput('geçen haftaki toplantı notları') },
  { id: 'q-word', text: buildQueryEmbeddingInput('kedi') },
  { id: 'q-mixed', text: buildQueryEmbeddingInput('invoice ödeme Q3 2026') },
  { id: 'q-emoji', text: buildQueryEmbeddingInput('trip to Japan 🇯🇵 ramen') },
  { id: 'q-code', text: buildQueryEmbeddingInput('useEffect cleanup function') },
  { id: 'q-de', text: buildQueryEmbeddingInput('Rezept für Apfelkuchen') },
  {
    id: 'd-short',
    text: buildEmbeddingInput(
      { title: 'Groceries', content: 'milk, eggs, bread, coffee' },
      'document'
    )
  },
  {
    id: 'd-untitled',
    text: buildEmbeddingInput(
      { content: 'Call the dentist about the appointment on Friday.' },
      'document'
    )
  },
  {
    id: 'd-tr',
    text: buildEmbeddingInput(
      {
        title: 'Haftalık plan',
        content:
          'Pazartesi spor salonu, salı müşteri görüşmesi, çarşamba kitap kulübü. İlaçları almayı unutma.'
      },
      'document'
    )
  },
  {
    id: 'd-markdown',
    text: buildEmbeddingInput(
      {
        title: 'Release checklist',
        content:
          '## Steps\n- [ ] bump version\n- [x] run `pnpm release`\n\n> Do not push to main.\n\n| a | b |\n|---|---|\n| 1 | 2 |'
      },
      'document'
    )
  },
  {
    id: 'd-code',
    text: buildEmbeddingInput(
      {
        title: 'Snippet',
        content:
          'function debounce(fn, ms) {\n  let t\n  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }\n}'
      },
      'document'
    )
  },
  {
    id: 'd-cjk',
    text: buildEmbeddingInput(
      { title: '東京旅行', content: '浅草寺と上野公園を訪れた。ラーメンが美味しかった。' },
      'document'
    )
  },
  {
    id: 'd-medium',
    text: buildEmbeddingInput({ title: 'Planning', content: paragraph.repeat(4) }, 'document')
  },
  ...buildEmbeddingChunks({ title: 'Quarterly planning', content: longBody })
    .slice(0, 3)
    .map((text, n) => ({ id: `d-window-${n}`, text })),
  {
    id: 's-similarity',
    text: buildEmbeddingInput(
      { title: 'Groceries', content: 'milk, eggs, bread, coffee' },
      'similarity'
    )
  },
  {
    id: 's-similarity-tr',
    text: buildEmbeddingInput(
      {
        title: 'Kitap notları',
        content: 'Suç ve Ceza, Dostoyevski. Raskolnikov’un vicdan muhasebesi.'
      },
      'similarity'
    )
  }
]
if (inputs.length !== 20) throw new Error(`expected 20 inputs, got ${inputs.length}`)

/** Same as `truncateEmbedding` in `embedding-worker.ts` (not importable: the module needs Electron's parentPort). */
function truncate(full: ArrayLike<number>): number[] {
  const out = Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => full[i])
  const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0))
  return out.map((v) => v / norm)
}

async function main(): Promise<void> {
  env.cacheDir = cache
  env.allowRemoteModels = false
  const config = await AutoConfig.from_pretrained(EMBEDDING_MODEL_REPO)
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- foreign runtime object with no published type for this member, as in embedding-worker.ts
  const sections = config as unknown as Record<string, unknown>
  sections.vision_config = null
  sections.audio_config = null
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(EMBEDDING_MODEL_REPO),
    AutoModel.from_pretrained(EMBEDDING_MODEL_REPO, {
      config,
      dtype: EMBEDDING_MODEL_DTYPE,
      device: 'cpu',
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 }
    })
  ])

  const vectors: Array<{ id: string; tokens: number; vector: number[] }> = []
  for (const input of inputs) {
    const text = input.text.substring(0, MAX_EMBEDDING_INPUT_LENGTH)
    const encoded = tokenizer([text], { padding: true, truncation: true })
    const output = (await model(encoded)) as { sentence_embedding: { data: ArrayLike<number> } }
    vectors.push({
      id: input.id,
      tokens: encoded.input_ids.dims[1],
      vector: truncate(output.sentence_embedding.data)
    })
  }
  await model.dispose()

  writeFileSync(join(outDir, 'parity-inputs.json'), JSON.stringify(inputs, null, 2))
  writeFileSync(join(outDir, 'desktop-vectors.json'), JSON.stringify({ vectors }))
  console.log(`wrote ${vectors.length} vectors to ${outDir}`)
}

void main()
