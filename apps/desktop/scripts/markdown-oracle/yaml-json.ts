/**
 * The JSON spelling of a js-yaml value, shared by the oracle entry (which
 * decodes dump inputs and encodes load outputs) and the Rust harness.
 *
 * JSON has no Date, Buffer, NaN, Infinity or negative zero, and a JavaScript
 * object cannot be told from a wrapper by shape alone, so those travel as
 * single-key objects. A map that itself has a key starting with `$` is wrapped
 * as `{"$map": {...}}`. Key order is `Object.keys` order, which JSON preserves.
 */
export type YamlJson = null | boolean | number | string | YamlJson[] | { [key: string]: YamlJson }

const SPECIAL_NUMBERS: Record<string, number> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
  '-0': -0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function encodeYaml(value: unknown): YamlJson {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value
    return { $num: Object.is(value, -0) ? '-0' : String(value) }
  }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Buffer.isBuffer(value)) return { $bin: value.toString('base64') }
  if (Array.isArray(value)) return value.map(encodeYaml)
  if (!isRecord(value)) throw new Error(`unencodable yaml value: ${typeof value}`)
  const entries = Object.keys(value).map((key): [string, YamlJson] => [key, encodeYaml(value[key])])
  const body = Object.fromEntries(entries)
  return entries.some(([key]) => key.startsWith('$')) ? { $map: body } : body
}

function defineAll(target: Record<string, unknown>, source: Record<string, YamlJson>): void {
  for (const key of Object.keys(source)) {
    // defineProperty: a `__proto__` key must stay an own property.
    Object.defineProperty(target, key, {
      value: decodeYaml(source[key]),
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
}

export function decodeYaml(json: YamlJson): unknown {
  if (json === null || typeof json !== 'object') return json
  if (Array.isArray(json)) return json.map(decodeYaml)
  const keys = Object.keys(json)
  if (keys.length === 1) {
    const [key] = keys
    const body = json[key]
    if (key === '$num' && typeof body === 'string') return SPECIAL_NUMBERS[body]
    if (key === '$date' && typeof body === 'string') return new Date(body)
    if (key === '$bin' && typeof body === 'string') return Buffer.from(body, 'base64')
    if (key === '$map' && isRecord(body)) {
      const out: Record<string, unknown> = {}
      defineAll(out, body)
      return out
    }
  }
  const out: Record<string, unknown> = {}
  defineAll(out, json)
  return out
}
