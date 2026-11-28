import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

// The Swift bindings are generated without `semantic` and the app links a build with it, so a
// UniFFI export behind that feature drifts silently (#5247). Each case is a crate's `src/`.
const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-uniffi-not-gated.mjs')
const EXPORT = '#[uniffi::export]\npub fn ungated() {}\n'

function check(files) {
  const root = mkdtempSync(join(tmpdir(), 'uniffi-gate-'))
  try {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), source)
    }
    return spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const gated = {
  'a cfg on the exported function': {
    'lib.rs': '#[cfg(feature = "semantic")]\n#[uniffi::export]\npub fn embed() {}\n'
  },
  'a cfg below the export attribute': {
    'lib.rs': '#[uniffi::export]\n#[cfg(feature = "semantic")]\npub fn embed() {}\n'
  },
  'the inverse polarity': {
    'lib.rs': '#[cfg(not(feature = "semantic"))]\n#[uniffi::export]\npub fn embed() {}\n'
  },
  'a gated method of an exported impl': {
    'lib.rs':
      '#[uniffi::export]\nimpl Index {\n    #[cfg(feature = "semantic")]\n    pub fn embed(&self) {}\n}\n'
  },
  'a gated impl holding a constructor': {
    'lib.rs':
      '#[cfg(feature = "semantic")]\nimpl Index {\n    #[uniffi::constructor]\n    pub fn new() -> Self {\n        Index\n    }\n}\n'
  },
  'a gated field of a record': {
    'lib.rs':
      '#[derive(uniffi::Record)]\npub struct Hit {\n    pub id: String,\n    #[cfg(feature = "semantic")]\n    pub score: f32,\n}\n'
  },
  'a derive behind cfg_attr': {
    'lib.rs': '#[cfg_attr(feature = "semantic", derive(uniffi::Record))]\npub struct Hit {}\n'
  },
  'a gated inline module': {
    'lib.rs':
      '#[cfg(feature = "semantic")]\nmod api {\n    #[uniffi::export]\n    pub fn embed() {}\n}\n'
  },
  'a gated macro export': {
    'lib.rs': `${EXPORT}#[cfg(feature = "semantic")]\nuniffi::custom_type!(Vector, Vec<f32>);\n`
  },
  'a gated file': {
    'lib.rs': 'mod api;\n',
    'api.rs': '#![cfg(feature = "semantic")]\n#[uniffi::export]\npub fn embed() {}\n'
  },
  'a submodule of a gated module': {
    'lib.rs': '#[cfg(feature = "semantic")]\npub mod api;\n',
    'api/mod.rs': 'mod search;\n',
    'api/search.rs': EXPORT
  },
  'a gated file whose first item is no export': {
    'lib.rs': 'mod api;\n',
    'api.rs': `#![cfg(feature = "semantic")]\nfn helper() {}\n${EXPORT}`
  },
  'a submodule of a gated file': {
    'lib.rs': 'mod api;\n',
    'api.rs': '#![cfg(feature = "semantic")]\nmod search;\n',
    'api/search.rs': EXPORT
  },
  'a submodule of a gated mod.rs': {
    'lib.rs': 'mod api;\n',
    'api/mod.rs': '#![cfg(feature = "semantic")]\nmod search;\n',
    'api/search.rs': EXPORT
  },
  'a file module of a gated inline module': {
    'lib.rs': '#[cfg(feature = "semantic")]\nmod api {\n    mod search;\n}\n',
    'api/search.rs': EXPORT
  },
  'stacked attributes before a gated module': {
    'lib.rs': '#[cfg(feature = "semantic")]\n#[allow(dead_code)]\npub mod api;\n',
    'api.rs': EXPORT
  },
  'stacked attributes before a gated generic impl': {
    'lib.rs':
      '#[cfg(feature = "semantic")]\n#[allow(dead_code)]\nimpl<A, B> Index<A, B> {\n    #[uniffi::constructor]\n    pub fn new() -> Self {\n        Index\n    }\n}\n'
  }
}

const allowed = {
  'a gated item beside an export': {
    'lib.rs': `#[cfg(feature = "semantic")]\nfn embed() -> Vec<f32> {\n    vec![]\n}\n${EXPORT}`
  },
  'a cfg inside an exported method body': {
    'lib.rs':
      '#[uniffi::export]\nimpl Index {\n    pub fn ready(&self) -> bool {\n        #[cfg(feature = "semantic")]\n        let ready = true;\n        #[cfg(not(feature = "semantic"))]\n        let ready = false;\n        ready\n    }\n}\n'
  },
  'brackets and cfgs inside comments and literals': {
    'lib.rs': `// #[cfg(feature = "semantic")]\n#[cfg(feature = "semantic")]\nfn open() -> (char, &'static str, &'static str) {\n    ('{', "{", r#"{"#)\n}\n/* #[cfg(feature = "semantic")] { */\n${EXPORT}`
  },
  'a gated module with no export': {
    'lib.rs': `#[cfg(feature = "semantic")]\nmod onnx;\n${EXPORT}`,
    'onnx.rs': 'pub fn embed() {}\n'
  }
}

describe('check-uniffi-not-gated', () => {
  for (const [name, files] of Object.entries(gated))
    it(`fails on ${name}`, () => {
      const result = check(files)
      assert.equal(result.status, 1, result.stdout)
      assert.match(result.stderr, /is behind .*feature = "semantic"/)
    })

  for (const [name, files] of Object.entries(allowed))
    it(`passes ${name}`, () => {
      const result = check(files)
      assert.equal(result.status, 0, result.stderr)
    })

  it('fails on a gated module whose file it cannot find', () => {
    const result = check({ 'lib.rs': `#[cfg(feature = "semantic")]\nmod gone;\n${EXPORT}` })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cannot find/)
  })

  it('fails on an import from uniffi, since attributes written through it name no uniffi path', () => {
    const result = check({
      'lib.rs': `${EXPORT}use uniffi::Record;\n\n#[derive(Record)]\npub struct Hit {}\n`
    })
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /lib\.rs:3 imports from uniffi/)
  })

  it('fails when it sees no export, since the root is then wrong', () => {
    assert.equal(check({ 'lib.rs': 'pub fn plain() {}\n' }).status, 1)
  })

  it('passes memry-core and counts its exports', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(Number(result.stdout.match(/(\d+) exports/)[1]) > 0, result.stdout)
  })
})
