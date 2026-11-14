/**
 * Generates the image vector classes of `memry-ml`:
 *
 * - `packages/contracts/test-vectors/pixel-tensors.json`: for each input image and soft-token
 *   budget, what Electron's image path hands the vision encoder (`RawImage.fromBlob`, `.rgb()`,
 *   `Gemma4ImageProcessor`), as sizes and sha256 hashes, or the error it throws. Needs no model.
 *   `crates/memry-ml/tests/pixel_tensors.rs` reproduces it.
 * - `packages/contracts/test-vectors/embeddings-image.json` (with `--model-dir`): the token ids and
 *   the stored 256-value vector of `embedImage` for photos, an OCR page with its text and small
 *   lossless images. `crates/memry-ml/tests/golden_image.rs` reproduces it.
 *
 *   pnpm embed:golden:image [--check]                    # pixel-tensors.json only
 *   pnpm embed:golden:image --model-dir <dir> [--check]  # both files
 *
 * Inputs are the repo's sample photos (`apps/cli/src/sandbox/assets`, by path and sha256) and
 * small images this script encodes with sharp, stored as base64 so the Rust test reads the same
 * bytes. With `--check`, the synthesized inputs are the committed ones, so the check compares
 * the preprocessing, not sharp's encoder. JPEG decoding and ICC conversion are a known divergence
 * (test-vectors README): those cases, found from the input bytes, also store the oracle's decoded
 * pixels, and the Rust holds them to `maxLevelDiff`.
 */
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'

import {
  AutoConfig,
  AutoModel,
  AutoProcessor,
  Gemma4ImageProcessor,
  RawImage,
  env
} from '@huggingface/transformers'
import sharp from 'sharp'

import {
  MODEL_REPO,
  MODEL_REVISION,
  ROOT,
  VECTORS,
  modelDir,
  sha256,
  sha256File,
  storedVector,
  truncateEmbedding,
  writeOrCheck
} from './common.mjs'

const ASSETS = 'apps/cli/src/sandbox/assets'

/** `image_processor` of the model's `processor_config.json` (the worker overrides the budget). */
const IMAGE_PROCESSOR = {
  do_convert_rgb: true,
  do_rescale: true,
  do_resize: true,
  max_soft_tokens: 280,
  patch_size: 16,
  pooling_kernel_size: 3,
  resample: 3,
  rescale_factor: 0.00392156862745098
}

/** `EMBEDDING_IMAGE_SOFT_TOKENS` and `EMBEDDING_PAGE_SOFT_TOKENS`. */
const IMAGE_TOKENS = 140
const PAGE_TOKENS = 280

/**
 * Largest per-channel difference between Electron's decoded pixels and the Rust ones in the
 * divergent cases (JPEG: zune-jpeg against libjpeg-turbo; ICC: moxcms against Little CMS; CMYK:
 * zune-jpeg's naive conversion against Little CMS through a CMYK profile), with a margin over the
 * measured maximum (jpeg 4, icc 1, jpeg+icc 6, cmyk 46, cmyk+icc 46). `pixel_tensors.rs` holds the
 * same values as ceilings: a higher one fails there.
 */
const MAX_LEVEL_DIFF = { jpeg: 6, icc: 2, 'jpeg+icc': 8, cmyk: 48, 'cmyk+icc': 48 }

/** The vision group of `crates/memry-ml/src/files.rs` and the text group. */
const PINS = {
  'tokenizer.json': '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4',
  'onnx/model_q4.onnx': 'f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9',
  'onnx/model_q4.onnx_data': 'c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49',
  'onnx/vision_encoder_q4.onnx': '7ea284226d4938f0ad921ab091f1d80a9ca699aa802984ef5cd5eec4f4761d96',
  'onnx/vision_encoder_q4.onnx_data':
    '0a9d6c927334f152a33dd90874f65d6ea5228999abe6a450d3f7813677fa704c'
}
const UNPINNED = ['config.json', 'tokenizer_config.json', 'processor_config.json']

const THREADS = Math.min(2, Math.max(1, Math.floor(os.availableParallelism() / 2)))

/** Text bounds of `golden_text.rs`; the JPEG photos are held to `jpegMinCosine` instead. */
const TOLERANCE = { minCosine: 0.9999, maxComponentDiff: 0.001 }

/**
 * Cosine bounds of the divergent cases with Electron's vector. Measured on macOS arm64: JPEG
 * photos 0.99972 to 0.99998 here, 0.9995 at worst over 20 sample images; the P3-tagged PNG
 * 0.99969. The bound leaves a margin of 5e-4 under the worst. CMYK JPEGs convert naively (Kaan,
 * 2026-11-14: accepted): 0.977145 without a profile, 0.978037 with the resampled one (0.985693
 * with libvips' whole profile), held to 0.97.
 */
const DIVERGENT_MIN_COSINE = {
  jpeg: 0.999,
  icc: 0.999,
  'jpeg+icc': 0.999,
  cmyk: 0.97,
  'cmyk+icc': 0.97
}

const asset = (name) => readFileSync(join(ROOT, ASSETS, name))

/** RGB pixels of a repo photo, resized with sharp: the base of the synthesized images. */
async function photo(name, width, height, channels = 3) {
  let image = sharp(asset(name)).resize(width, height, { fit: 'fill' })
  if (channels === 4) image = image.ensureAlpha()
  const { data } = await image.raw().toBuffer({ resolveWithObject: true })
  if (channels === 4) {
    // A diagonal alpha ramp, so dropping alpha is visible.
    for (let i = 0; i < width * height; i++) data[i * 4 + 3] = (i * 7) % 256
  }
  return sharp(data, { raw: { width, height, channels } })
}

/** A PNG of the given size whose IHDR is then rewritten (CRC included) to `width` x `height`. */
async function pngWithHeader(width, height) {
  const png = await (await photo('photo-kyoto.jpg', 8, 8)).png().toBuffer()
  const out = Buffer.from(png)
  out.writeUInt32BE(width, 16)
  out.writeUInt32BE(height, 20)
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29)
  return out
}

function crc32(bytes) {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

/** Two frames side by side in time: `join.animated` makes an animated GIF or WebP. */
async function animated(format) {
  const frames = await Promise.all(
    ['photo-tokyo.jpg', 'photo-lisbon.jpg'].map(async (name) =>
      (await photo(name, 40, 30)).png().toBuffer()
    )
  )
  return sharp(frames, { join: { animated: true } })
    .toFormat(format, { loop: 0, delay: [100, 100] })
    .toBuffer()
}

const GRID = 9

/** An uncompressed CMYK TIFF of `width` x `height` pixels, which libvips reads as CMYK. */
function cmykTiff(width, height, pixels) {
  const entries = [
    [256, 4, width],
    [257, 4, height],
    [258, 3, 4, 134],
    [259, 3, 1],
    [262, 3, 5],
    [273, 4, 142],
    [277, 3, 4],
    [278, 4, height],
    [279, 4, pixels.length],
    [284, 3, 1]
  ]
  const head = Buffer.alloc(142)
  head.write('II*\0', 0, 'latin1')
  head.writeUInt32LE(8, 4)
  head.writeUInt16LE(entries.length, 8)
  entries.forEach(([tag, type, value, at], i) => {
    const entry = 10 + i * 12
    head.writeUInt16LE(tag, entry)
    head.writeUInt16LE(type, entry + 2)
    head.writeUInt32LE(at === undefined ? 1 : value, entry + 4)
    if (at !== undefined) head.writeUInt32LE(at, entry + 8)
    else if (type === 3) head.writeUInt16LE(value, entry + 8)
    else head.writeUInt32LE(value, entry + 8)
  })
  for (let i = 0; i < 4; i++) head.writeUInt16LE(8, 134 + i * 2)
  return Buffer.concat([head, pixels])
}

/**
 * libvips' built-in CMYK profile resampled on a `GRID`^4 lattice, as one `lut16Type` table to PCS
 * XYZ shared by A2B0, A2B1 and A2B2: about 40 KB where the profile itself is 940 KB, too large to
 * store as base64. Each node is the sRGB libvips converts it to through that profile, back in XYZ
 * D50. Little CMS then converts close to how libvips' profile does, where `memry-ml` drops it.
 */
async function cmykProfile() {
  const ascii = (text) => Buffer.from(text, 'latin1')
  const u16 = (values) => {
    const out = Buffer.alloc(values.length * 2)
    values.forEach((value, i) => out.writeUInt16BE(value, i * 2))
    return out
  }
  const u32 = (values) => {
    const out = Buffer.alloc(values.length * 4)
    values.forEach((value, i) => out.writeUInt32BE(value >>> 0, i * 4))
    return out
  }
  const xyz = (x, y, z) =>
    Buffer.concat([ascii('XYZ '), u32([0]), u32([x, y, z].map((v) => Math.round(v * 65536)))])
  const text = (value) => Buffer.concat([ascii('text'), u32([0]), ascii(`${value}\0`)])
  const desc = (value) =>
    Buffer.concat([
      ascii('desc'),
      u32([0, value.length + 1]),
      ascii(`${value}\0`),
      Buffer.alloc(4 + 4 + 2 + 1 + 67)
    ])
  const nodes = GRID ** 4
  const lattice = Buffer.alloc(nodes * 4)
  for (let node = 0; node < nodes; node++) {
    for (let ink = 0; ink < 4; ink++) {
      const step = Math.floor(node / GRID ** (3 - ink)) % GRID
      lattice[node * 4 + ink] = Math.round((step * 255) / (GRID - 1))
    }
  }
  const side = GRID ** 2
  const srgb = await sharp(cmykTiff(side, side, lattice))
    .toColourspace('rgb16')
    .raw({ depth: 'ushort' })
    .toBuffer()
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  // sRGB to XYZ D50 (Bradford-adapted).
  const matrix = [
    [0.4360747, 0.3850649, 0.1430804],
    [0.2225045, 0.7168786, 0.0606169],
    [0.0139322, 0.0971045, 0.7141733]
  ]
  const clut = []
  for (let node = 0; node < nodes; node++) {
    const rgb = [0, 1, 2].map((c) => linear(srgb.readUInt16LE((node * 3 + c) * 2) / 65535))
    for (const row of matrix) {
      clut.push(Math.round(row.reduce((sum, weight, i) => sum + weight * rgb[i], 0) * 32768))
    }
  }
  const lut = Buffer.concat([
    ascii('mft2'),
    u32([0]),
    Buffer.from([4, 3, GRID, 0]),
    u32([65536, 0, 0, 0, 65536, 0, 0, 0, 65536]),
    u16([2, 2]),
    u16([0, 65535, 0, 65535, 0, 65535, 0, 65535]),
    u16(clut),
    u16([0, 65535, 0, 65535, 0, 65535])
  ])
  const tags = [
    ['desc', desc('memry test CMYK')],
    ['cprt', text('No copyright, use freely')],
    ['wtpt', xyz(0.9642, 1, 0.8249)],
    ['A2B0', lut],
    ['A2B1', lut],
    ['A2B2', lut]
  ]
  const pad = (bytes) => Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)])
  const table = Buffer.alloc(4 + tags.length * 12)
  table.writeUInt32BE(tags.length, 0)
  const bodies = []
  const offsets = new Map()
  let offset = 128 + table.length
  tags.forEach(([signature, body], i) => {
    if (!offsets.has(body)) {
      offsets.set(body, offset)
      bodies.push(pad(body))
      offset += pad(body).length
    }
    table.write(signature, 4 + i * 12, 'latin1')
    table.writeUInt32BE(offsets.get(body), 8 + i * 12)
    table.writeUInt32BE(body.length, 12 + i * 12)
  })
  const header = Buffer.alloc(128)
  header.writeUInt32BE(offset, 0)
  header.writeUInt32BE(0x02100000, 8)
  header.write('prtrCMYKXYZ ', 12, 'latin1')
  header.write('acsp', 36, 'latin1')
  // The D50 illuminant, s15Fixed16.
  xyz(0.9642, 1, 0.8249).copy(header, 68, 8)
  return Buffer.concat([header, table, ...bodies])
}

/** A JPEG with `profile` spliced in as one APP2 `ICC_PROFILE` segment after SOI. */
function withIcc(jpeg, profile) {
  const payload = Buffer.concat([
    Buffer.from('ICC_PROFILE\0', 'latin1'),
    Buffer.from([1, 1]),
    profile
  ])
  const marker = Buffer.from([0xff, 0xe2, 0, 0])
  marker.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)])
}

/**
 * The divergence class of an input, as `crates/memry-ml/tests/common/mod.rs` reads it from the
 * bytes: a CMYK or YCCK JPEG (four components) with or without a profile, another JPEG, an ICC
 * profile, both, or none (decoded bit for bit).
 */
async function divergence(bytes) {
  let metadata = {}
  try {
    metadata = await sharp(bytes).metadata()
  } catch {
    // An input sharp cannot read is refused in both and carries no class.
  }
  const { format, hasProfile, channels } = metadata
  if (format === 'jpeg' && channels === 4) return hasProfile ? 'cmyk+icc' : 'cmyk'
  if (format === 'jpeg') return hasProfile ? 'jpeg+icc' : 'jpeg'
  return hasProfile ? 'icc' : undefined
}

/**
 * The synthesized inputs. Sizes stay small so the base64 stays small; the budgets put most of them
 * through the resize.
 */
async function synthesized() {
  const base = () => photo('photo-istanbul.jpg', 64, 48)
  const rgba = () => photo('photo-berlin.jpg', 64, 48, 4)
  const cases = [
    ['png rgb', (await base()).png().toBuffer()],
    ['png rgba', (await rgba()).png().toBuffer()],
    ['png grey', (await base()).greyscale().png().toBuffer()],
    ['png grey alpha', (await rgba()).greyscale().png().toBuffer()],
    ['png palette', (await base()).png({ palette: true, colours: 64, dither: 0 }).toBuffer()],
    ['png palette trns', (await rgba()).png({ palette: true, colours: 64, dither: 0 }).toBuffer()],
    ['png 16-bit', (await base()).toColourspace('rgb16').png().toBuffer()],
    ['png p3 profile', (await base()).withIccProfile('p3').png().toBuffer()],
    ['png exact size', (await photo('photo-romanesco.jpg', 48, 48)).png().toBuffer()],
    ['png 1x500', (await photo('photo-new-york.jpg', 1, 500)).png().toBuffer()],
    ['png 500x1', (await photo('photo-new-york.jpg', 500, 1)).png().toBuffer()],
    ['png 3x200', (await photo('photo-new-york.jpg', 3, 200)).png().toBuffer()],
    ['jpeg 4:2:0', (await base()).jpeg({ quality: 85 }).toBuffer()],
    ['jpeg 4:4:4', (await base()).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()],
    ['jpeg progressive', (await base()).jpeg({ progressive: true }).toBuffer()],
    ['jpeg grey', (await base()).greyscale().jpeg().toBuffer()],
    ['jpeg p3 profile', (await base()).withIccProfile('p3').jpeg().toBuffer()],
    ['jpeg cmyk', (await base()).toColourspace('cmyk').jpeg().toBuffer()],
    [
      'jpeg cmyk profile',
      withIcc(await (await base()).toColourspace('cmyk').jpeg().toBuffer(), await cmykProfile())
    ],
    ...(await Promise.all(
      [2, 3, 4, 5, 6, 7, 8].map(async (orientation) => [
        `jpeg orientation ${orientation}`,
        await (
          await photo('photo-tokyo.jpg', 40, 24)
        )
          .jpeg({ quality: 90 })
          .withMetadata({ orientation })
          .toBuffer()
      ])
    )),
    ['webp lossy', (await base()).webp({ quality: 80 }).toBuffer()],
    ['webp lossless', (await base()).webp({ lossless: true }).toBuffer()],
    ['webp alpha', (await rgba()).webp({ lossless: true }).toBuffer()],
    ['webp p3 profile', (await base()).withIccProfile('p3').webp({ lossless: true }).toBuffer()],
    ['webp animated', await animated('webp')],
    ['gif', (await base()).gif().toBuffer()],
    ['gif transparent', (await rgba()).gif().toBuffer()],
    ['gif animated', await animated('gif')]
  ]
  const valid = await Promise.all(
    cases.map(async ([name, bytes]) => ({ name, bytes: await bytes }))
  )
  const png = valid[0].bytes
  const jpeg = valid.find((item) => item.name === 'jpeg 4:2:0').bytes
  const malformed = [
    ['empty', Buffer.alloc(0)],
    ['random bytes', Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 73 + 41) % 256))],
    ['wrong magic', Buffer.concat([Buffer.from('GIF89a'), png.subarray(6)])],
    ['png truncated', png.subarray(0, Math.floor(png.length / 2))],
    ['jpeg truncated', jpeg.subarray(0, Math.floor(jpeg.length / 2))],
    ['png zero width', await pngWithHeader(0, 8)],
    ['png huge dimensions', await pngWithHeader(100_000, 100_000)],
    ['png over the pixel limit', await pngWithHeader(0x3fff + 1, 0x3fff)]
  ].map(([name, bytes]) => ({ name, bytes }))
  return [...valid, ...malformed]
}

/** Repo photos: JPEG camera images and an OCR page, embedded by path. */
const REPO_IMAGES = [
  'photo-istanbul.jpg',
  'photo-blue-marble.jpg',
  'photo-romanesco.jpg',
  'ocr-strunk-elements-of-style-p24.jpg',
  'ocr-fda-nutrition-facts.png'
]

const hex = (array) => sha256(Buffer.from(array.buffer, array.byteOffset, array.byteLength))

/** Electron's preprocessing of one input, as sizes and hashes, or the error it throws. */
async function pixelTensor(processor, bytes, softTokens, withPixels) {
  let raw
  try {
    raw = (await RawImage.fromBlob(new Blob([bytes]))).rgb()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  processor.max_soft_tokens = softTokens
  let output
  try {
    output = await processor(raw)
  } catch (error) {
    return { decoded: { width: raw.width, height: raw.height }, error: String(error.message) }
  }
  const positions = output.image_position_ids.data
  let patches = 0
  let width = 0
  let height = 0
  for (let i = 0; i < positions.length; i += 2) {
    if (positions[i] < 0n) break
    patches++
    width = Math.max(width, Number(positions[i]) + 1)
    height = Math.max(height, Number(positions[i + 1]) + 1)
  }
  return {
    decoded: {
      width: raw.width,
      height: raw.height,
      sha256: hex(raw.data),
      ...(withPixels ? { rgb: Buffer.from(raw.data).toString('base64') } : {})
    },
    resized: { width: width * 16, height: height * 16 },
    maxPatches: output.pixel_values.dims[1],
    patches,
    numSoftTokens: output.num_soft_tokens_per_image[0],
    pixelValues: hex(output.pixel_values.data),
    positionIds: hex(positions)
  }
}

async function pixelTensorsFile(inputs) {
  const processor = new Gemma4ImageProcessor(IMAGE_PROCESSOR)
  const cases = []
  for (const input of inputs) {
    for (const softTokens of input.softTokens) {
      // Large repo photos carry no pixels: the Rust bounds their embeddings instead.
      const expected = await pixelTensor(
        processor,
        input.bytes,
        softTokens,
        input.divergent && input.source.input
      )
      const divergent = input.divergent && !expected.error ? { divergent: input.divergent } : {}
      cases.push({
        name: `${input.name} @${softTokens}`,
        ...input.source,
        softTokens,
        ...divergent,
        expected
      })
    }
  }
  return {
    description:
      "Electron's image preprocessing (RawImage.fromBlob, .rgb(), Gemma4ImageProcessor) per input and soft-token budget: decoded and resized sizes, sha256 of the decoded RGB bytes, of pixel_values (f32 LE) and of image_position_ids (i64 LE), or the error. Divergent cases (JPEG decoding, ICC conversion, naive CMYK conversion) carry the decoded RGB as base64 and maxLevelDiff.",
    generator: 'crates/memry-ml/tests/golden/generate-image.mjs',
    sharp: sharp.versions.sharp,
    transformers: env.version,
    vips: sharp.versions.vips,
    imageProcessor: IMAGE_PROCESSOR,
    maxLevelDiff: MAX_LEVEL_DIFF,
    cases
  }
}

/** The synthesized inputs of the committed `pixel-tensors.json` by name, for `--check`. */
function committedInputs() {
  const path = join(VECTORS, 'pixel-tensors.json')
  if (!process.argv.includes('--check') || !existsSync(path)) return new Map()
  const { cases } = JSON.parse(readFileSync(path, 'utf8'))
  return new Map(
    cases
      .filter((item) => item.input !== undefined)
      .map((item) => [item.name.replace(/ @\d+$/, ''), Buffer.from(item.input, 'base64')])
  )
}

async function allInputs() {
  const committed = committedInputs()
  const small = (await synthesized()).map(({ name, bytes }) => ({
    name,
    bytes: committed.get(name) ?? bytes
  }))
  const budgets = (name) =>
    name === 'png exact size'
      ? [1]
      : /^png \d+x\d+$/.test(name)
        ? [1, IMAGE_TOKENS]
        : [IMAGE_TOKENS]
  const inputs = [
    ...small.map(({ name, bytes }) => ({
      name,
      bytes,
      softTokens: budgets(name),
      source: { input: bytes.toString('base64') }
    })),
    ...REPO_IMAGES.map((name) => {
      const bytes = asset(name)
      return {
        name,
        bytes,
        softTokens: [IMAGE_TOKENS, PAGE_TOKENS],
        source: { path: `${ASSETS}/${name}`, sha256: sha256(bytes) }
      }
    })
  ]
  return Promise.all(
    inputs.map(async (input) => ({ ...input, divergent: await divergence(input.bytes) }))
  )
}

async function main() {
  const all = await allInputs()
  const pixels = await pixelTensorsFile(all)
  writeOrCheck(join(VECTORS, 'pixel-tensors.json'), `${JSON.stringify(pixels, null, 2)}\n`, {})
  if (!process.argv.includes('--model-dir') && !process.env.MEMRY_ML_MODEL_DIR) return
  const dir = modelDir(PINS)
  const embeddings = await embeddingsFile(dir, all)
  writeOrCheck(join(VECTORS, 'embeddings-image.json'), embeddings.json, TOLERANCE)
}

/**
 * The embedded images: every repo image at both budgets, the OCR page with its text interleaved
 * (as `buildInterleavedInput` writes it), and the exact lossless inputs.
 */
const OCR_TEXT =
  'Omit needless words. Vigorous writing is concise. A sentence should contain no unnecessary words'

function embeddingCases(all) {
  const byName = new Map(all.map((input) => [input.name, input]))
  const pick = (name, softTokens, text) => ({ input: byName.get(name), softTokens, text })
  return [
    ...REPO_IMAGES.filter((name) => name.startsWith('photo-')).map((name) =>
      pick(name, IMAGE_TOKENS, null)
    ),
    pick('photo-istanbul.jpg', PAGE_TOKENS, null),
    pick('ocr-fda-nutrition-facts.png', IMAGE_TOKENS, null),
    pick('ocr-fda-nutrition-facts.png', PAGE_TOKENS, null),
    pick(
      'ocr-strunk-elements-of-style-p24.jpg',
      PAGE_TOKENS,
      `title: none | text: ${OCR_TEXT} <|image|>`
    ),
    pick(
      'ocr-fda-nutrition-facts.png',
      PAGE_TOKENS,
      'title: none | text: Nutrition Facts <|image|>'
    ),
    pick('png rgb', IMAGE_TOKENS, null),
    pick('png rgba', IMAGE_TOKENS, null),
    pick('webp lossless', IMAGE_TOKENS, null),
    pick('webp lossy', IMAGE_TOKENS, null),
    pick('gif', IMAGE_TOKENS, null),
    pick('png p3 profile', IMAGE_TOKENS, null),
    pick('jpeg cmyk', IMAGE_TOKENS, null),
    pick('jpeg cmyk profile', IMAGE_TOKENS, null)
  ]
}

async function embeddingsFile(dir, all) {
  env.allowRemoteModels = false
  env.localModelPath = resolve(dir, '../..')
  const config = await AutoConfig.from_pretrained(MODEL_REPO)
  config.audio_config = null
  const [model, processor] = await Promise.all([
    AutoModel.from_pretrained(MODEL_REPO, {
      config,
      dtype: 'q4',
      device: 'cpu',
      session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 }
    }),
    AutoProcessor.from_pretrained(MODEL_REPO)
  ])
  const cases = []
  for (const { input, softTokens, text } of embeddingCases(all)) {
    // embedding-worker.ts embedImage.
    const raw = await RawImage.fromBlob(new Blob([input.bytes]))
    processor.image_processor.max_soft_tokens = softTokens
    const inputs = await processor(text, raw)
    const output = await model(inputs)
    const tokenIds = Array.from(inputs.input_ids.data, Number)
    cases.push({
      name: `${input.name} @${softTokens}${text ? ' with text' : ''}`,
      image: input.name,
      softTokens,
      text,
      divergent: input.divergent ?? null,
      tokenIds,
      embedding: storedVector(truncateEmbedding(output.sentence_embedding.data))
    })
  }
  await model.dispose()
  const file = {
    description:
      'embedding-worker.ts embedImage on transformers.js: token ids and the stored 256-value vector per image, soft-token budget and interleaved text. Images are pixel-tensors.json inputs by name.',
    generator: 'crates/memry-ml/tests/golden/generate-image.mjs',
    transformers: env.version,
    model: MODEL_REPO,
    revision: MODEL_REVISION,
    files: Object.fromEntries(
      [...Object.keys(PINS), ...UNPINNED].map((name) => [name, sha256File(join(dir, name))])
    ),
    tolerance: TOLERANCE,
    divergentMinCosine: DIVERGENT_MIN_COSINE,
    cases
  }
  return { json: `${JSON.stringify(file, null, 2)}\n` }
}

await main()
