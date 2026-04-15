# Crypto Golden-Vector Fixtures

RFC-derived test vectors used by `apps/desktop/src/main/crypto` to prove
that our libsodium wrappers and any future cross-implementation code agree
with the canonical specifications.

These fixtures are inputs to tests, not runtime code. They are intentionally
imported eagerly so that the typed loader (`load-vectors.ts`) catches shape
drift the moment a vector file is edited.

## Files

| File | Algorithm | Source |
| --- | --- | --- |
| `xchacha20-rfc8439.ts` | XChaCha20-Poly1305 (IETF) | [draft-irtf-cfrg-xchacha-03 §A.3.1](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03#appendix-A.3.1) |
| `ed25519-rfc8032.ts` | Ed25519 (pure) | [RFC 8032 §7.1](https://datatracker.ietf.org/doc/html/rfc8032#section-7.1) |
| `argon2id-rfc9106.ts` | Argon2id | [RFC 9106 §5.3](https://datatracker.ietf.org/doc/html/rfc9106#section-5.3) |
| `load-vectors.ts` | typed loader + shape assertions | — |

All vector files were captured on **2026-04-16**. The retrieval date is also
recorded in each file header and on each exported vector constant.

## Vector shape

Every vector exports a typed constant with the following invariants enforced
at import time by `assert*Vector` helpers in `load-vectors.ts`:

- All cryptographic material is a `Uint8Array` (never a hex string at the
  consumer boundary — the file uses `hexToBytes` only as an internal helper).
- Length-bound fields (keys, nonces, signatures, tags) carry their expected
  length on the type and are validated.
- Each vector carries `name`, `source` (RFC reference), and `retrievedAt`.

## Tamper sentinels

Each vector file reserves a `// SHA-256:` line next to its expected-output
literal. The line is intentionally left empty in this scaffolding commit so
no stale value can mask a later silent edit; the first consuming test run
should compute and pin the value via the recipe below.

```bash
# from apps/desktop, run inside a vitest test or one-off `tsx` script —
# direct `node --input-type=module -e` cannot resolve the .ts import.

pnpm exec tsx -e '
  import { createHash } from "node:crypto"
  import { XCHACHA20_RFC8439_DRAFT_VECTOR } from "./src/main/crypto/__fixtures__/xchacha20-rfc8439"
  const v = XCHACHA20_RFC8439_DRAFT_VECTOR
  const buf = Buffer.concat([Buffer.from(v.ciphertext), Buffer.from(v.tag)])
  console.log(createHash("sha256").update(buf).digest("hex"))
'
```

Substitute the vector import + concatenated bytes as appropriate:

| Vector file | Bytes to hash |
| --- | --- |
| `xchacha20-rfc8439.ts` | `ciphertext ‖ tag` |
| `ed25519-rfc8032.ts` | `signature` |
| `argon2id-rfc9106.ts` | `tag` |

Once a sentinel is pinned, edits that change the literal will produce a hash
mismatch the first time a consuming test re-runs the recipe, surfacing the
tamper.

## Re-fetching from the RFCs

If the upstream vector ever needs to be re-verified:

1. Open the source URL listed in the file header.
2. Copy each hex blob *exactly* — keep groupings reproducible (we use
   32-hex-char chunks so diffs stay local).
3. Update the `retrievedAt` field on the vector constant **and** the
   per-file header comment to match the day of re-fetch (ISO `YYYY-MM-DD`).
4. Re-run the SHA-256 regeneration recipe above and update the comment
   sentinel near the literal.
5. Run `pnpm --filter desktop test --project main src/main/crypto/` to
   confirm any consuming tests still pass.

## Adding a new vector

1. Create a new `<algorithm>-<source>.ts` file in this directory.
2. Define a typed interface in `load-vectors.ts` and an `assert*Vector`
   helper that enforces every length / structural invariant.
3. Export the vector constant wrapped in the assert helper so corrupted
   data fails at import time, not at first use.
4. Document source URL, retrieval date, and any deviations from Memry's
   runtime parameters (e.g., Argon2id parallelism mismatch).
5. Update this README's table.

## Memry runtime parameter deviations

These vectors exercise the canonical RFC primitive. Memry's production
parameters do not always match the RFC reference vector parameters:

- **Argon2id**: RFC 9106 §5.3 uses parallelism = 4. libsodium's
  `crypto_pwhash` hardcodes parallelism = 1, which is why
  `packages/contracts/src/crypto.ts` documents p = 1 as our canonical
  value. The RFC vector therefore validates the primitive
  (cross-implementation tests via `@noble/hashes` or similar), not
  Memry's `crypto_pwhash` instantiation.
- **XChaCha20-Poly1305 / Ed25519**: no deviation — libsodium's
  `crypto_aead_xchacha20poly1305_ietf_*` and `crypto_sign_*` directly match
  the cited RFC / draft constructions.
