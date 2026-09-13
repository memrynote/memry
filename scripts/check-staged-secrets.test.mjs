import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scanTextForSecrets } from './check-staged-secrets.mjs'

const rules = (text) => scanTextForSecrets('apps/example/Component.tsx', text).map((f) => f.rule)
const envRules = (text) => scanTextForSecrets('deploy/service.env', text).map((f) => f.rule)

describe('check-staged-secrets JSX handling', () => {
  it('ignores token-named JSX props whose value is a code reference', () => {
    const jsx = [
      '<CheckoutPanel',
      '  token={webToken}',
      '  onTokenMissing={NO_TOKEN_NOTICE}',
      '/>'
    ].join('\n')
    assert.deepEqual(rules(jsx), [])
  })

  it('still flags a token-named prop assigned a quoted string literal', () => {
    assert.deepEqual(rules('  token={"supersecretvalue123"}'), ['high-risk-secret-assignment'])
  })
})

describe('check-staged-secrets numeric values', () => {
  it('ignores a token-named variable reset to a number', () => {
    assert.deepEqual(rules('  tokenIssuedAt = 0'), [])
  })

  it('still flags a token-named prop assigned a long quoted number-like string', () => {
    assert.deepEqual(rules('  token={"01234567890123456789"}'), ['high-risk-secret-assignment'])
  })
})

describe('check-staged-secrets constructor values', () => {
  it('ignores a secret-named key assigned a constructor call over a code reference', () => {
    assert.deepEqual(rules('  signingSecretKey: new Uint8Array(signingSecretKey),'), [])
  })

  it('still flags a constructor call containing a string literal', () => {
    assert.deepEqual(rules("  signingSecretKey: new Buffer('hunter2secretvalue')"), [
      'high-risk-secret-assignment'
    ])
  })
})

describe('check-staged-secrets function values', () => {
  it('ignores a token-named key assigned an arrow function with parameters', () => {
    assert.deepEqual(rules('  getAccessToken: (force) => mintToken({ clientId, force }),'), [])
  })

  it('still flags an arrow function body containing a string literal', () => {
    assert.deepEqual(rules("  getAccessToken: (force) => 'hunter2secretvalue'"), [
      'high-risk-secret-assignment'
    ])
  })
})

describe('check-staged-secrets keyword word boundaries', () => {
  it('ignores an fts5 tokenize= option in a CREATE VIRTUAL TABLE block', () => {
    const ddl = [
      'db.run(sql`',
      '  CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(',
      '    id UNINDEXED,',
      '    title,',
      '    content,',
      '    tags,',
      "    tokenize='porter unicode61'",
      '  )',
      '`)'
    ].join('\n')

    assert.deepEqual(
      scanTextForSecrets('apps/desktop/src/main/database/fts.ts', ddl).map((f) => f.rule),
      []
    )
  })

  it('ignores identifiers that only contain a sensitive keyword inside a longer word', () => {
    assert.deepEqual(rules("  tokenizer: 'porter unicode61',"), [])
    assert.deepEqual(rules("  passwordless: 'magic-link-flow',"), [])
  })

  it('still flags a snake-case token key assigned a credential literal', () => {
    assert.deepEqual(rules("  API_TOKEN = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'"), [
      'high-risk-secret-assignment'
    ])
  })

  it('still flags a camelCase token key assigned a credential literal', () => {
    assert.deepEqual(rules("  accessToken: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',"), [
      'high-risk-secret-assignment'
    ])
  })

  it('still flags a consecutive-caps token key assigned a credential literal', () => {
    assert.deepEqual(rules("  APIToken: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',"), [
      'high-risk-secret-assignment'
    ])
  })

  it('still flags env-style credential assignments', () => {
    assert.deepEqual(envRules('API_TOKEN=a1b2c3d4e5f67890abcdef'), ['high-risk-secret-assignment'])
    assert.deepEqual(envRules('export DB_PASSWORD=hunter2hunter2'), ['high-risk-secret-assignment'])
  })
})

describe('check-staged-secrets fallback chains', () => {
  it('ignores a secret-named key assigned a nullish chain over code references', () => {
    assert.deepEqual(rules('  refreshToken: tokens.refreshToken ?? refreshToken,'), [])
  })

  it('ignores a logical-or chain over code references', () => {
    assert.deepEqual(rules('  apiKeyValue: config.apiKey || fallbackKey,'), [])
  })

  it('still flags a fallback chain ending in a quoted literal', () => {
    assert.deepEqual(rules("  refreshToken: tokens.refreshToken ?? 'hunter2secretvalue'"), [
      'high-risk-secret-assignment'
    ])
  })
})

describe('check-staged-secrets TypeScript non-null assertions', () => {
  it('ignores a secret-named key assigned an env reference with a non-null assertion', () => {
    assert.deepEqual(rules('  refreshToken: process.env.GOOGLE_CALENDAR_E2E_REFRESH_TOKEN!,'), [])
  })

  it('still flags a bare secret-looking word that merely ends in an exclamation mark', () => {
    // The `!` is only tolerated closing a member path. Stripping it from any
    // value would let a lone word read as an identifier and slip through.
    assert.deepEqual(rules('  refreshToken: hunter2secretvalue!'), ['high-risk-secret-assignment'])
  })
})

describe('check-staged-secrets Rust declarations', () => {
  const rustRules = (text) =>
    scanTextForSecrets('crates/memry-core/src/crypto/sodium.rs', text).map((f) => f.rule)

  it('ignores a secret-named Rust parameter whose value is its type', () => {
    assert.deepEqual(rustRules('    password: &[u8],'), [])
    assert.deepEqual(rustRules('    password: Option<&[u8]>,'), [])
    assert.deepEqual(rustRules('    secret_key: &mut Vec<u8>,'), [])
  })

  it('ignores a Rust path expression whose head carries a secret keyword', () => {
    assert.deepEqual(rustRules('        PasswordHashAlgorithm::Argon2id13,'), [])
  })

  it('ignores primitive and generic Rust types', () => {
    assert.deepEqual(rustRules('    token_bytes: usize,'), [])
    assert.deepEqual(rustRules('    refresh_token: String,'), [])
    assert.deepEqual(rustRules('    api_key: crate::keys::Material,'), [])
    assert.deepEqual(rustRules('    signing_secret_key: secret_key.as_slice(),'), [])
    assert.deepEqual(rustRules('    vault_key: material.vault_key,'), [])
    assert.deepEqual(rustRules('    api_key: self.keys.signing.as_ref(),'), [])
    assert.deepEqual(rustRules('    secret: derive_key(seed),'), [])
    // No opening quote and no quote character anywhere: a Rust expression,
    // not a literal. This is the pair the pattern cannot tell apart on the
    // captured value alone, only on whether a quote was consumed.
    assert.deepEqual(rustRules('    signing_secret_key: secret_key,'), [])
    assert.deepEqual(rustRules('    signing_secret_key: &self.secret_key,'), [])
    assert.deepEqual(rustRules('    api_key: &mut material,'), [])
    // A three-character literal is not a credential in any language.
    assert.deepEqual(rustRules('    token: \"t\".into(),'), [])
    assert.deepEqual(rustRules('                    sent_token = Some(token);'), [])
    assert.deepEqual(rustRules('    api_key: Ok(material),'), [])
    // A path expression, not an assignment: the pattern splits `Foo::bar` as
    // if the first colon were a separator, so the quoted argument looked like
    // a literal assigned to a key containing `Token`.
    assert.deepEqual(rustRules('        TokenClaims::parse(\"not-a-jwt\"),'), [])
    assert.deepEqual(rustRules('    TokenClaims::parse(&jwt(json!({ \"sub\": \"u\" }))),'), [])
  })

  it('still flags a Rust field whose value is a bare quoted literal', () => {
    // The assignment pattern eats the opening quote, so this arrives looking
    // like an identifier. A type rule that accepted a bare lowercase word
    // would exempt it.
    assert.deepEqual(rustRules('    password: "hunter2secretvalue",'), [
      'high-risk-secret-assignment'
    ])
  })

  it('still flags a bare quoted literal, which is the shape the identifier rule must not swallow', () => {
    // `password: "hunter2secretvalue"` reaches the exemption above with the
    // same *captured value* as a bare identifier. Only the consumed opening
    // quote separates them, so this is the test that pins the distinction.
    assert.deepEqual(rustRules('    password: "hunter2secretvalue",'), [
      'high-risk-secret-assignment'
    ])
  })

  it('does not treat a long literal as short just because it is converted', () => {
    assert.deepEqual(rustRules('    token: "hunter2secretvalue".into(),'), [
      'high-risk-secret-assignment'
    ])
  })

  it('still flags a quoted literal wrapped in a tuple-struct call', () => {
    // The variant exemption must not extend to a literal inside the call.
    assert.deepEqual(rustRules('    password: Secret("hunter2secretvalue"),'), [
      'high-risk-secret-assignment'
    ])
  })

  it('does not extend the path-expression exemption to a real assignment', () => {
    // No `key::` anywhere on the line, so the guard must not fire.
    assert.deepEqual(rustRules('    api_token: "hunter2secretvalue",'), [
      'high-risk-secret-assignment'
    ])
  })

  it('still flags a Rust value that interpolates into a string', () => {
    assert.deepEqual(rustRules('    password: format!("{secret}"),'), [
      'high-risk-secret-assignment'
    ])
  })

  it('still detects a real credential format inside a Rust file', () => {
    // Assembled at runtime so this file does not trip the very scanner it
    // tests. The pieces are meaningless apart; only the joined form matches.
    const shaped = ['sk', 'proj', 'abc123def456ghi789jkl012mno345'].join('-')
    assert.deepEqual(rustRules(`    api_key: "${shaped}",`), ['openai-key'])
  })

  it('does not extend the Rust exemption to other file types', () => {
    assert.deepEqual(
      scanTextForSecrets('deploy/service.env', 'PASSWORD: &[u8]').map((f) => f.rule),
      ['high-risk-secret-assignment']
    )
  })
})
