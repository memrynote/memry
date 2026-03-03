# Certificate Pinning

## What It Does

Certificate pinning hardcodes the server's TLS certificate fingerprints (SPKI hashes) into the Electron binary. Even if a certificate authority is compromised, the app rejects any cert that doesn't match the pinned hashes.

## Where Things Live

| What                 | Where                                  | Who manages it          |
| -------------------- | -------------------------------------- | ----------------------- |
| TLS certificate      | Cloudflare (auto-provisioned)          | Cloudflare              |
| SPKI pin hashes      | `src/main/sync/certificate-pinning.ts` | Us (hardcoded)          |
| Build-time check     | `scripts/check-cert-hashes.sh`         | CI (runs in `prebuild`) |
| Hash extraction tool | `scripts/extract-cert-hashes.ts`       | Dev utility             |

## Pinning Strategy

Pin **two** certificates for resilience:

```
PINNED_CERTIFICATE_HASHES = [
  'sha256/...',  // Leaf cert (primary) — strongest, but rotates
  'sha256/...'   // Intermediate CA (backup) — survives leaf rotation
]
```

Cloudflare rotates leaf certs periodically. The intermediate pin keeps the app working between releases.

## Production Deployment Checklist

### First time (before shipping v1)

1. Deploy `sync.memrynote.com` on Cloudflare
2. Extract hashes:
   ```bash
   pnpm cert:extract sync.memrynote.com
   ```
3. Copy the **LEAF** hash as primary, **INTERMEDIATE** hash as backup
4. Replace placeholders in `src/main/sync/certificate-pinning.ts`
5. Verify:
   ```bash
   pnpm cert:check  # should pass (no PLACEHOLDER found)
   pnpm build       # prebuild runs cert:check automatically
   ```

### On certificate rotation

Cloudflare leaf certs rotate ~every 90 days. The intermediate pin keeps users connected during the gap.

1. Get notified of rotation (Cloudflare dashboard or monitoring)
2. Extract new hashes:
   ```bash
   pnpm cert:extract sync.memrynote.com
   ```
3. Update the **leaf hash** (first entry) in `PINNED_CERTIFICATE_HASHES`
4. If intermediate CA also changed, update backup hash too
5. Ship app update

### If both pins break simultaneously

The runtime guard (`hasPlaceholderHashes`) won't help here since these are real hashes that stopped matching. Users on old app versions will lose sync until they update.

Mitigation: monitor pin mismatches server-side (the app logs `Certificate pin verification failed` with the actual hash).

## Safety Nets

Three independent layers prevent bricking:

| Layer                                    | When             | What happens                                              |
| ---------------------------------------- | ---------------- | --------------------------------------------------------- |
| **Build-time** (`prebuild`)              | `pnpm build`     | Blocks build if `PLACEHOLDER` found in source             |
| **Runtime: getPinnedCertificateHashes**  | App startup      | Returns `[]` if placeholders detected in packaged app     |
| **Runtime: createPinnedAgent**           | HTTP client init | Falls back to standard TLS agent if placeholders detected |
| **Session: configureCertificatePinning** | Electron session | Skips `setCertificateVerifyProc` if pin list is empty     |

All three log `CRITICAL` or `error` level messages so they're visible in production logs.

## Scripts

```bash
pnpm cert:check                          # verify no placeholders remain
pnpm cert:extract                        # extract from sync.memrynote.com (default)
pnpm cert:extract api.example.com        # extract from custom hostname
pnpm cert:extract api.example.com 8443   # custom hostname + port
```
