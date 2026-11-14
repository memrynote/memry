/**
 * Generates the two audio vector classes of `memry-ml`:
 *
 * - `packages/contracts/test-vectors/audio-features.json`: what Electron's `decodeWavForEmbedding`
 *   returns for WAV files (valid, malformed and unsupported), the windows `embedAudio` embeds for a
 *   recording length, and the log-mel features and mask transformers.js's audio processor gives
 *   for a window. `crates/memry-ml/tests/audio_features.rs` reproduces it without the model.
 * - `packages/contracts/test-vectors/embeddings-audio.json`: the token ids and the stored 256-value
 *   vector of every window Electron embeds for a WAV file, which
 *   `crates/memry-ml/tests/golden_audio.rs` reproduces with the native engine.
 *
 *   pnpm embed:golden:audio --model-dir <dir>            # write both files
 *   pnpm embed:golden:audio --model-dir <dir> --check    # regenerate in memory, compare, write nothing
 *
 * `<dir>` (or `MEMRY_ML_MODEL_DIR`) is a `.../onnx-community/embeddinggemma-2-ONNX` folder holding
 * the text and audio files of revision `MODEL_REVISION`, as in an Electron profile that embedded a
 * voice memo. Nothing is downloaded, and CI does not run `--check`, because it needs the model.
 *
 * The oracle is Electron's audio path. `apps/desktop/src/main/lib/audio-embedding.ts` runs in
 * place: its settings and database imports are stubbed (audio search on), and its call into the
 * embedding worker, `generateAudioEmbedding`, is replaced by the worker's `embedAudio`
 * (`embedding-worker.ts`), repeated here because the worker cannot be imported outside an
 * Electron utility process: `processor(null, null, audio)`, the model, `truncateEmbedding`.
 *
 * Every input is built from integer recipes (an LCG, square and triangle waves), so the Rust tests
 * rebuild the same bytes without storing them: see `tests/common/mod.rs`.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AutoConfig, AutoModel, AutoProcessor, env } from '@huggingface/transformers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const VECTORS = join(ROOT, 'packages/contracts/test-vectors')
const FEATURES_OUT = join(VECTORS, 'audio-features.json')
const EMBEDDINGS_OUT = join(VECTORS, 'embeddings-audio.json')
const AUDIO_EMBEDDING = join(ROOT, 'apps/desktop/src/main/lib/audio-embedding.ts')

const MODEL_REPO = 'onnx-community/embeddinggemma-2-ONNX'
const MODEL_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
/** The text and audio groups of `crates/memry-ml/src/files.rs`. */
const PINS = {
  'tokenizer.json': '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4',
  'onnx/model_q4.onnx': 'f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9',
  'onnx/model_q4.onnx_data': 'c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49',
  'onnx/audio_encoder_q4.onnx': 'c4cce3370e72262280d00293cac038896050a03a8e9a27e10b061ca97510296e',
  'onnx/audio_encoder_q4.onnx_data':
    'ba9328e6341360974083085b44b2bba265003bda564740f7c4c23ed9928f17e2'
}
/** Read by transformers.js but not by the native engine; their hashes are recorded. */
const UNPINNED = [
  'config.json',
  'tokenizer_config.json',
  'processor_config.json',
  'preprocessor_config.json'
]

const DIMENSION = 256
const THREADS = Math.min(2, Math.max(1, Math.floor(os.availableParallelism() / 2)))

/** Acceptance of #3540, as for `embeddings-text.json`. */
const EMBEDDING_TOLERANCE = { minCosine: 0.9999, maxComponentDiff: 0.001 }
/**
 * Largest difference of one log-mel value. transformers.js multiplies the mel filters on ONNX
 * Runtime in f32 with its own summation order; the values are logs of an energy plus 0.001, so a
 * relative error of 1e-6 in the energy moves a value by about 1e-6.
 */
const FEATURE_TOLERANCE = { maxAbsDiff: 1e-4 }

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

// --- Inputs --------------------------------------------------------------------------------

/**
 * One integer sample per frame and channel, from a list of segments:
 * `noise` draws `(x >>> 16) - 32768` from the LCG `x = x * 1664525 + 1013904223 (mod 2^32)`
 * seeded with `seed`, one draw per sample, then shifts it right by `shift`; `square` and
 * `triangle` repeat every `period` frames between `-amplitude` and `amplitude`, shifted right by
 * the channel index; `silence` is zero.
 */
function* recipeSamples(signal, channels) {
  for (const segment of signal) {
    let x = segment.seed >>> 0
    for (let frame = 0; frame < segment.frames; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        if (segment.kind === 'noise') {
          x = (Math.imul(x, 1664525) + 1013904223) >>> 0
          yield ((x >>> 16) - 32768) >> segment.shift
        } else if (segment.kind === 'square') {
          const phase = frame % segment.period
          const value = phase * 2 < segment.period ? segment.amplitude : -segment.amplitude
          yield value >> channel
        } else if (segment.kind === 'triangle') {
          const { period, amplitude } = segment
          const phase = frame % period
          const up = Math.floor((4 * amplitude * phase) / period)
          yield (phase * 2 < period ? -amplitude + up : 3 * amplitude - up) >> channel
        } else if (segment.kind === 'silence') {
          yield 0
        } else {
          throw new Error(`unknown segment ${segment.kind}`)
        }
      }
    }
  }
}

/**
 * A RIFF/WAVE file: a `fmt ` chunk (16 bytes, or 40 for WAVE_FORMAT_EXTENSIBLE with `subFormat`),
 * then a `data` chunk. Integer samples are written as PCM16, as PCM32 shifted left by 16, or as
 * float32 divided by 32768.
 */
function wav({ format, subFormat, bits, channels, sampleRate, signal }) {
  const ints = Array.from(recipeSamples(signal, channels))
  const bytesPerSample = bits / 8
  const extensible = format === 0xfffe
  const fmtSize = extensible ? 40 : 16
  const dataSize = ints.length * bytesPerSample
  const bytes = new Uint8Array(12 + 8 + fmtSize + 8 + dataSize)
  const view = new DataView(bytes.buffer)
  const tag = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, fmtSize, true)
  view.setUint16(20, format, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bits, true)
  if (extensible) {
    view.setUint16(36, 22, true)
    view.setUint16(38, bits, true)
    view.setUint32(40, 0, true)
    view.setUint16(44, subFormat, true)
  }
  const data = 20 + fmtSize
  tag(data, 'data')
  view.setUint32(data + 4, dataSize, true)
  ints.forEach((value, i) => {
    const at = data + 8 + i * bytesPerSample
    if (format === 3 || subFormat === 3) view.setFloat32(at, value / 32768, true)
    else if (bits === 16) view.setInt16(at, value, true)
    else view.setInt32(at, value * 65536, true)
  })
  return bytes
}

const hex = (bytes) => Buffer.from(bytes).toString('hex')
const fromHex = (text) => new Uint8Array(Buffer.from(text, 'hex'))

/** Little-endian chunk helpers for the hand-made files. */
const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff]
const ascii = (text) => [...text].map((c) => c.charCodeAt(0))
const fmtBody = (format, channels, rate, bits) => [
  ...u16(format),
  ...u16(channels),
  ...u32(rate),
  ...u32(rate * channels * (bits / 8)),
  ...u16(channels * (bits / 8)),
  ...u16(bits)
]
const riff = (...chunks) => {
  const body = [...ascii('WAVE'), ...chunks.flat()]
  return new Uint8Array([...ascii('RIFF'), ...u32(body.length), ...body])
}
const chunk = (id, body, size = body.length) => [
  ...ascii(id),
  ...u32(size),
  ...body,
  ...(body.length % 2 ? [0] : [])
]
const pcm16 = (values) => values.flatMap((v) => u16(v & 0xffff))

const noise = (frames, seed, shift = 0) => [{ kind: 'noise', frames, seed, shift }]
const pcm = (channels, sampleRate, signal, bits = 16) => ({
  format: 1,
  bits,
  channels,
  sampleRate,
  signal
})

/**
 * WAV files for `decodeWavForEmbedding`. `wav` holds the bytes, so malformed files need no recipe.
 * `divergence` marks a file the native decoder refuses on purpose.
 */
function decodeCases() {
  const short = [1000, -2000, 3000, -4000, 32767, -32768]
  return [
    ['pcm16 mono 16 kHz', wav(pcm(1, 16000, noise(200, 1)))],
    ['pcm16 stereo 16 kHz averages the channels', wav(pcm(2, 16000, noise(100, 2)))],
    [
      'pcm16 three channels 44.1 kHz',
      wav(pcm(3, 44100, [{ kind: 'triangle', frames: 441, period: 37, amplitude: 20000 }]))
    ],
    ['pcm32 mono 22.05 kHz', wav(pcm(1, 22050, noise(300, 3), 32))],
    ['float32 stereo 48 kHz', wav({ ...pcm(2, 48000, noise(480, 4)), format: 3, bits: 32 })],
    ['pcm16 mono 8 kHz upsamples', wav(pcm(1, 8000, noise(100, 5)))],
    ['pcm16 mono 11.025 kHz upsamples', wav(pcm(1, 11025, noise(57, 6)))],
    [
      'extensible pcm16 44.1 kHz',
      wav({ ...pcm(1, 44100, noise(441, 7)), format: 0xfffe, subFormat: 1 })
    ],
    [
      'extensible float32 32 kHz',
      wav({ ...pcm(2, 32000, noise(320, 8)), format: 0xfffe, subFormat: 3, bits: 32 })
    ],
    [
      'chunks before fmt, one odd-sized and padded',
      riff(
        chunk('LIST', ascii('INFOISFT')),
        chunk('junk', [1, 2, 3]),
        chunk('fmt ', fmtBody(1, 1, 16000, 16)),
        chunk('data', pcm16(short))
      )
    ],
    [
      'data size past the end of the file is cut',
      riff(chunk('fmt ', fmtBody(1, 1, 16000, 16)), [
        ...ascii('data'),
        ...u32(1000),
        ...pcm16(short)
      ])
    ],
    [
      'data size 0xffffffff',
      riff(chunk('fmt ', fmtBody(1, 1, 16000, 16)), [
        ...ascii('data'),
        ...u32(0xffffffff),
        ...pcm16(short)
      ])
    ],
    [
      'odd data byte count drops the partial frame',
      riff(chunk('fmt ', fmtBody(1, 2, 16000, 16)), chunk('data', [...pcm16(short), 7]))
    ],
    [
      'empty data chunk at 16 kHz',
      riff(chunk('fmt ', fmtBody(1, 1, 16000, 16)), chunk('data', []))
    ],
    [
      'empty data chunk at 44.1 kHz',
      riff(chunk('fmt ', fmtBody(1, 1, 44100, 16)), chunk('data', []))
    ],
    [
      'second fmt chunk wins',
      riff(
        chunk('fmt ', fmtBody(1, 1, 8000, 8)),
        chunk('fmt ', fmtBody(1, 1, 16000, 16)),
        chunk('data', pcm16(short))
      )
    ],
    ['data before fmt', riff(chunk('data', pcm16(short)), chunk('fmt ', fmtBody(1, 1, 16000, 16)))],
    ['no data chunk', riff(chunk('fmt ', fmtBody(1, 1, 16000, 16)))],
    ['no fmt chunk', riff(chunk('data', pcm16(short)))],
    [
      'fmt chunk shorter than 16 bytes',
      riff([...ascii('fmt '), ...u32(16), ...fmtBody(1, 1, 16000, 16).slice(0, 10)])
    ],
    [
      'huge chunk size skips past the end',
      riff([...ascii('JUNK'), ...u32(0xfffffff0), 0, 0], chunk('fmt ', fmtBody(1, 1, 16000, 16)))
    ],
    ['pcm8', riff(chunk('fmt ', fmtBody(1, 1, 16000, 8)), chunk('data', [1, 2, 3, 4]))],
    ['pcm24', riff(chunk('fmt ', fmtBody(1, 1, 16000, 24)), chunk('data', [1, 2, 3, 4, 5, 6]))],
    [
      'float64',
      riff(
        chunk('fmt ', fmtBody(3, 1, 16000, 64)),
        chunk(
          'data',
          Array.from({ length: 16 }, () => 0)
        )
      )
    ],
    ['a-law', riff(chunk('fmt ', fmtBody(6, 1, 8000, 16)), chunk('data', pcm16(short)))],
    ['extensible a-law', wav({ ...pcm(1, 8000, noise(10, 9)), format: 0xfffe, subFormat: 6 })],
    ['zero channels', riff(chunk('fmt ', fmtBody(1, 0, 16000, 16)), chunk('data', pcm16(short)))],
    ['zero sample rate', riff(chunk('fmt ', fmtBody(1, 1, 0, 16)), chunk('data', pcm16(short)))],
    ['RIFF but not WAVE', new Uint8Array([...ascii('RIFF'), ...u32(4), ...ascii('AVI ')])],
    [
      'not RIFF',
      new Uint8Array(ascii('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000'))
    ],
    ['eleven bytes', new Uint8Array([...ascii('RIFF'), ...u32(3), ...ascii('WAV')])],
    ['empty', new Uint8Array(0)],
    [
      'sample rate under 4 kHz',
      riff(chunk('fmt ', fmtBody(1, 1, 3000, 16)), chunk('data', pcm16(short))),
      'the native decoder refuses sample rates under 4000 Hz (a tiny file would claim hours)'
    ]
  ].map(([name, bytes, divergence]) => ({
    name,
    wav: hex(bytes),
    ...(divergence ? { divergence } : {})
  }))
}

/** Recording lengths (16 kHz samples) around `embedAudio`'s window, minimum and cap rules. */
const WINDOW_LENGTHS = [
  0,
  15_999,
  16_000,
  4_800_000,
  4_815_999,
  4_816_000,
  9_616_000,
  12 * 4_800_000 + 16_000
]

const featureCase = (name, signal) => ({ name, signal })
const embeddingCase = (name, recipe) => ({ name, recipe })

/** Windows for the feature extractor: 16 kHz mono samples, `int / 32768`. */
const FEATURE_CASES = [
  ['one second of noise', noise(16_000, 11)],
  ['quiet noise, length not a multiple of 128', noise(16_197, 12, 6)],
  ['one second of silence', [{ kind: 'silence', frames: 16_000 }]],
  [
    'square then triangle, 2.5 s',
    [
      { kind: 'square', frames: 20_000, period: 64, amplitude: 12_000 },
      { kind: 'triangle', frames: 20_000, period: 91, amplitude: 25_000 }
    ]
  ],
  ['half a second', noise(8_000, 13)],
  ['under one frame', noise(300, 14)],
  ['31 s: the extractor keeps 30 s', noise(16_000 * 31, 15, 2)]
].map(([name, signal]) => featureCase(name, signal))

/** WAV files Electron embeds end to end. */
const EMBEDDING_CASES = [
  ['one second of noise, pcm16 mono 16 kHz', pcm(1, 16_000, noise(16_000, 21))],
  [
    'tones, pcm16 stereo 44.1 kHz, 3 s',
    pcm(2, 44_100, [
      { kind: 'square', frames: 44_100, period: 100, amplitude: 9_000 },
      { kind: 'triangle', frames: 88_200, period: 201, amplitude: 20_000 }
    ])
  ],
  [
    'silence then noise, float32 48 kHz, 2 s',
    {
      ...pcm(1, 48_000, [{ kind: 'silence', frames: 48_000 }, ...noise(48_000, 22, 3)]),
      format: 3,
      bits: 32
    }
  ],
  [
    'triangle, extensible pcm32 22.05 kHz, 1.5 s',
    {
      ...pcm(1, 22_050, [{ kind: 'triangle', frames: 33_075, period: 50, amplitude: 30_000 }], 32),
      format: 0xfffe,
      subFormat: 1
    }
  ],
  ['31 s of noise: the extractor keeps 30 s', pcm(1, 16_000, noise(16_000 * 31, 23, 1))],
  ['301 s: two windows, the second one second long', pcm(1, 16_000, noise(16_000 * 301, 24, 2))],
  ['300.5 s: the half-second tail is dropped', pcm(1, 16_000, noise(16_000 * 300 + 8_000, 25, 2))],
  ['0.9 s: too short to embed', pcm(1, 16_000, noise(14_400, 26))]
].map(([name, recipe]) => embeddingCase(name, recipe))

// --- Oracle --------------------------------------------------------------------------------

/**
 * Runs `audio-embedding.ts` in place: its imports other than `./embeddings-constants` resolve to a
 * stub with audio search on, whose `generateAudioEmbedding` calls `globalThis.__memryAudioOracle`.
 */
async function loadAudioEmbedding() {
  const stub = `data:text/javascript,${encodeURIComponent(`
    export const getSetting = () => 'true'
    export const getDatabase = () => ({})
    export const getVoiceTranscriptionSettings = () => ({ audioSearch: true })
    export const generateAudioEmbedding = (window) => globalThis.__memryAudioOracle(window)
  `)}`
  const parent = pathToFileURL(AUDIO_EMBEDDING).href
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL !== parent) return next(specifier, context)
      if (specifier === './embeddings-constants') return next(`${specifier}.ts`, context)
      return { url: stub, shortCircuit: true }
    }
  })
  return import(parent)
}

async function loadModel(dir) {
  env.allowRemoteModels = false
  env.localModelPath = resolve(dir, '../..')
  // embedding-worker.ts loadEmbeddingPipeline({ audio: true }) on a worker without vision.
  const config = await AutoConfig.from_pretrained(MODEL_REPO)
  config.vision_config = null
  const [model, processor] = await Promise.all([
    AutoModel.from_pretrained(MODEL_REPO, {
      config,
      dtype: 'q4',
      device: 'cpu',
      session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 }
    }),
    AutoProcessor.from_pretrained(MODEL_REPO)
  ])
  return { model, processor }
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

/** Nine significant digits give back the same f32. */
const f32 = (values) => Array.from(values, (value) => Number(value.toPrecision(9)))

const mono16k = (signal) => Float32Array.from(recipeSamples(signal, 1), (value) => value / 32768)

/** The rows of a feature matrix the file keeps whole: the edges and the middle. */
const keptRows = (frames) =>
  [...new Set([0, 1, 2, frames >> 1, frames - 3, frames - 2, frames - 1])]
    .filter((row) => row >= 0 && row < frames)
    .toSorted((a, b) => a - b)

async function renderFeatures(audioEmbedding, processor, unpinnedFiles) {
  const decode = decodeCases().map((item) => {
    const samples = audioEmbedding.decodeWavForEmbedding(fromHex(item.wav))
    return { ...item, expected: samples === null ? null : Array.from(samples) }
  })

  const windows = []
  for (const samples of WINDOW_LENGTHS) {
    const seen = []
    globalThis.__memryAudioOracle = async (window) => {
      seen.push(window.length)
      return new Float32Array(DIMENSION)
    }
    const vectors = await audioEmbedding.embedAudio(new Float32Array(samples))
    windows.push({ samples, windows: vectors === null ? [] : seen })
  }

  const features = []
  for (const item of FEATURE_CASES) {
    const audio = mono16k(item.signal)
    let expected
    try {
      const inputs = await processor.feature_extractor(audio)
      const [, frames, width] = inputs.input_features.dims
      const data = inputs.input_features.data
      const mask = Array.from(inputs.input_features_mask.data, Number)
      const rowSums = []
      for (let row = 0; row < frames; row++) {
        let sum = 0
        for (let i = 0; i < width; i++) sum += data[row * width + i]
        rowSums.push(Number(sum.toPrecision(9)))
      }
      const validFrames = mask.indexOf(0) === -1 ? frames : mask.indexOf(0)
      if (mask.slice(validFrames).some(Boolean))
        throw new Error(`${item.name}: mask is not a prefix`)
      let softTokens = 0
      for (let i = 0; i < mask.length; i += 4) softTokens += mask[i]
      expected = {
        frames,
        validFrames,
        softTokens,
        rowSums,
        rows: Object.fromEntries(
          keptRows(frames).map((row) => [row, f32(data.subarray(row * width, (row + 1) * width))])
        )
      }
    } catch (error) {
      expected = { error: error instanceof Error ? error.message : String(error) }
    }
    features.push({ ...item, samples: audio.length, expected })
  }

  return {
    meta: {
      spec: 'tauri-v2-3540-audio-features',
      oracle:
        'crates/memry-ml/tests/golden/generate-audio.mjs (Electron audio-embedding.ts in place, transformers.js Gemma4AudioFeatureExtractor)',
      transformers: transformersVersion(),
      unpinnedFiles,
      note: 'decode[i].expected is decodeWavForEmbedding(wav) (16 kHz mono f32, exact) or null. windows[i].windows lists the lengths embedAudio hands the worker for a recording of `samples` 16 kHz samples. features[i] runs the processor feature extractor on 16 kHz mono samples built from `signal`: rows keeps whole feature rows by index, rowSums sums every row, validFrames is the length of the mask prefix of ones, softTokens counts the mask at every 4th frame. Recipes: see generate-audio.mjs recipeSamples.'
    },
    tolerance: FEATURE_TOLERANCE,
    decode,
    windows,
    features
  }
}

async function renderEmbeddings(audioEmbedding, { model, processor }, unpinnedFiles) {
  const cases = []
  for (const item of EMBEDDING_CASES) {
    const samples = audioEmbedding.decodeWavForEmbedding(wav(item.recipe))
    if (samples === null) throw new Error(`${item.name}: Electron does not decode it`)
    const windows = []
    globalThis.__memryAudioOracle = async (window) => {
      // embedding-worker.ts embedAudio.
      const inputs = await processor(null, null, window)
      const output = await model(inputs)
      const embedding = truncateEmbedding(output.sentence_embedding.data)
      const tokenIds = Array.from(inputs.input_ids.data, Number)
      windows.push({ samples: window.length, tokenIds, embedding: f32(embedding) })
      return embedding
    }
    const vectors = await audioEmbedding.embedAudio(samples)
    if ((vectors?.length ?? 0) !== windows.length) throw new Error(`${item.name}: lost a window`)
    cases.push({ name: item.name, recipe: item.recipe, decodedSamples: samples.length, windows })
  }
  return {
    meta: {
      spec: 'tauri-v2-3540-embeddings-audio',
      oracle:
        'crates/memry-ml/tests/golden/generate-audio.mjs (Electron audio-embedding.ts in place, the audio path of embedding-worker.ts on transformers.js)',
      transformers: transformersVersion(),
      model: { repo: MODEL_REPO, revision: MODEL_REVISION, dtype: 'q4' },
      unpinnedFiles,
      note: 'Each case is a WAV file built from `recipe` (generate-audio.mjs wav). windows lists what Electron embeds: decodeWavForEmbedding, embedAudio windows, then per window processor(null, null, window) and the model. tokenIds are the processor input_ids; embedding is the stored 256-value vector.'
    },
    tolerance: EMBEDDING_TOLERANCE,
    cases
  }
}

function transformersVersion() {
  return JSON.parse(
    readFileSync(join(ROOT, 'node_modules/@huggingface/transformers/package.json'), 'utf8')
  ).version
}

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0)
const worstDiff = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])))

/**
 * Differences between two renders: exact on everything but embeddings and features, which may
 * differ within the file's tolerance, so a run on another CPU or thread count still passes.
 */
function differences(committed, fresh, tolerance, path = '') {
  const numbers = Array.isArray(committed) && Array.isArray(fresh)
  if (numbers && path.endsWith('.embedding')) {
    const ok =
      committed.length === fresh.length &&
      dot(committed, fresh) >= tolerance.minCosine &&
      worstDiff(committed, fresh) <= tolerance.maxComponentDiff
    return ok ? [] : [`${path}: cosine ${dot(committed, fresh)}`]
  }
  if (numbers && (/\.rows\.\d+$/.test(path) || path.endsWith('.rowSums'))) {
    const bound = path.endsWith('.rowSums') ? 128 * tolerance.maxAbsDiff : tolerance.maxAbsDiff
    const ok = committed.length === fresh.length && worstDiff(committed, fresh) <= bound
    return ok ? [] : [`${path}: largest difference ${worstDiff(committed, fresh)}`]
  }
  if (
    typeof committed !== 'object' ||
    committed === null ||
    typeof fresh !== 'object' ||
    fresh === null
  ) {
    return Object.is(committed, fresh) ? [] : [`${path}: ${committed} != ${fresh}`]
  }
  const keys = new Set([...Object.keys(committed), ...Object.keys(fresh)])
  return [...keys].flatMap((key) =>
    differences(committed[key], fresh[key], tolerance, `${path}.${key}`)
  )
}

async function main() {
  const dir = modelDir()
  const unpinnedFiles = Object.fromEntries(UNPINNED.map((file) => [file, sha256(join(dir, file))]))
  const audioEmbedding = await loadAudioEmbedding()
  const engine = await loadModel(dir)
  const outputs = [
    {
      out: FEATURES_OUT,
      document: await renderFeatures(audioEmbedding, engine.processor, unpinnedFiles)
    },
    { out: EMBEDDINGS_OUT, document: await renderEmbeddings(audioEmbedding, engine, unpinnedFiles) }
  ]
  let failed = false
  for (const { out, document } of outputs) {
    const fresh = `${JSON.stringify(document, null, 2)}\n`
    if (!process.argv.includes('--check')) {
      writeFileSync(out, fresh, 'utf8')
      process.stdout.write(`wrote ${out}\n`)
      continue
    }
    let found = [`${basename(out)} is missing`]
    try {
      found = differences(JSON.parse(readFileSync(out, 'utf8')), document, document.tolerance)
    } catch (error) {
      found = [`${basename(out)}: ${error instanceof Error ? error.message : String(error)}`]
    }
    if (found.length > 0) {
      failed = true
      process.stderr.write(
        `${basename(out)} regenerates differently:\n${found.slice(0, 20).join('\n')}\n`
      )
    } else {
      process.stdout.write(`${basename(out)} is current\n`)
    }
  }
  if (failed) process.exit(1)
}

await main()
