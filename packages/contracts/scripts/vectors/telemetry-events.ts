/**
 * Class: telemetry event schema (`telemetry-events.json`).
 *
 * The closed name and surface lists, the dimension key allowlist, and the outputs of
 * `sanitizeTelemetryDimensions`, `sanitizeTelemetryFailure` and `toSafeToken`, produced by
 * the production functions. The Rust telemetry client replays them, so a name or a rule
 * added on one side fails the other.
 *
 * Multi-key dimension inputs list their keys alphabetically: the Rust map is ordered, a JS
 * object keeps insertion order, and the first allowed key wins in both.
 */
import {
  TELEMETRY_DIMENSION_KEYS,
  TelemetryEventNameSchema,
  TelemetryResultSchema,
  TelemetrySurfaceSchema,
  sanitizeTelemetryDimensions,
  sanitizeTelemetryFailure,
  toSafeToken
} from '../../src/telemetry-api'
import { meta } from './shared'

const UUID = '123e4567-e89b-12d3-a456-426614174000'

const DIMENSIONS: Array<Record<string, string> | undefined> = [
  undefined,
  {},
  { setting: 'general.theme' },
  { setting: 'x'.repeat(64) },
  { setting: 'x'.repeat(65) },
  { setting: 'a/b' },
  { setting: 'a@b' },
  { setting: 'https://x.test' },
  { setting: UUID },
  { setting: '' },
  { unknown_key: 'ok' },
  { distinct_id: 'x' },
  { $set: 'x' },
  { ip: '1.2.3.4' },
  { changed_fields: 'a,b' },
  { capture_type: 'url' },
  { decision: 'keep' },
  { filed_action: 'note' },
  { format: 'md' },
  { from_version: '1.0.0' },
  { itemType: 'note' },
  { log_action: 'group_corrupted_reset' },
  { note_bucket: '10-99' },
  { prior_app_version: '1.2.3' },
  { result_bucket: 'many' },
  { size_bucket: 'small' },
  { skip_reason: 'offline' },
  { target: 'main' },
  { target_app_version: '2.0.0' },
  { tool: 'search' },
  { transport: 'http' },
  { value: '42' },
  { a_unknown: 'x', setting: 'ok' },
  { setting: 'a/b', value: 'fine' },
  { capture_type: 'x@y', format: 'md' },
  { distinct_id: 'x', setting: 'ok' },
  { setting: '日本語' },
  { setting: '😀'.repeat(32) },
  { setting: '😀'.repeat(33) },
  { setting: 'line\nbreak' },
  { setting: ' ' }
]

const FAILURES: Array<Record<string, unknown> | undefined> = [
  undefined,
  {},
  { httpStatus: 500 },
  { httpStatus: 99 },
  { httpStatus: 600 },
  { httpStatus: 404.5 },
  { httpStatus: '500' },
  { serverCode: 'VALIDATION_ERROR' },
  { serverCode: 'lowercase' },
  { serverCode: 'A'.repeat(64) },
  { serverCode: 'A'.repeat(65) },
  { serverCode: '' },
  { retryable: true },
  { retryable: 'yes' },
  { httpStatus: 503, serverCode: 'STORAGE_QUOTA_EXCEEDED', retryable: false },
  { httpStatus: 0, serverCode: 'X', retryable: true },
  { httpStatus: 200, serverCode: 5, retryable: false }
]

const TOKENS: Array<[unknown, string]> = [
  ['plain', 'fb'],
  ['with space', 'fb'],
  ['a/b', 'fb'],
  ['a@b.c', 'fb'],
  ['x'.repeat(100), 'fb'],
  ['', 'fb'],
  ['ok-1_2.3:4', 'fb'],
  ['über', 'fb'],
  ['😀', 'fb'],
  ['Err or', 'fb'],
  [42, 'fb'],
  [true, 'fb'],
  [null, 'fb'],
  [undefined, 'fb'],
  [{}, 'fb'],
  ['://', 'fb'],
  ['\\', 'fb']
]

// One bare key each, and a few with a value that must be dropped.
DIMENSIONS.push(
  ...TELEMETRY_DIMENSION_KEYS.map((key) => ({ [key]: 'ok' })),
  ...TELEMETRY_DIMENSION_KEYS.slice(0, 6).map((key) => ({ [key]: 'a/b' }))
)

export function buildTelemetryEvents(): Record<string, unknown> {
  return {
    meta: meta({
      class: 'telemetry-events',
      implementation: 'packages/contracts/src/telemetry-api.ts'
    }),
    eventNames: TelemetryEventNameSchema.options,
    surfaces: TelemetrySurfaceSchema.options,
    results: TelemetryResultSchema.options,
    dimensionKeys: TELEMETRY_DIMENSION_KEYS,
    dimensions: DIMENSIONS.map((input) => ({
      input: input ?? null,
      expected: sanitizeTelemetryDimensions(input) ?? null
    })),
    failures: FAILURES.map((input) => ({
      input: input ?? null,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately malformed inputs are the point of this class
      expected: sanitizeTelemetryFailure(input as never) ?? null
    })),
    tokens: TOKENS.map(([input, fallback]) => ({
      input: input ?? null,
      inputKind: input === undefined ? 'undefined' : input === null ? 'null' : typeof input,
      fallback,
      expected: toSafeToken(input, fallback)
    }))
  }
}
