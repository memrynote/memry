import type { SyncSubscription } from './lib/sync-types'

export type Bindings = {
  DB: D1Database
  STORAGE: R2Bucket
  USER_SYNC_STATE: DurableObjectNamespace
  LINKING_SESSION: DurableObjectNamespace
  RATE_LIMITER: DurableObjectNamespace
  ENVIRONMENT: string
  LOCAL_ADMIN_SYNC_EMAILS?: string
  ALLOWED_ORIGIN?: string
  JWT_PUBLIC_KEY: string
  JWT_PRIVATE_KEY: string
  RESEND_API_KEY: string
  FEEDBACK_RECIPIENT: string
  OTP_HMAC_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GOOGLE_REDIRECT_URI: string
  GOOGLE_DESKTOP_CLIENT_ID?: string
  GOOGLE_DESKTOP_CLIENT_SECRET?: string
  // The iOS app's own OAuth client. Its id is the audience the native sign-in
  // ID token carries, and there is no secret because a public client has
  // nowhere to keep one.
  GOOGLE_IOS_CLIENT_ID?: string
  WEB_OAUTH_REDIRECT_URI?: string
  MIN_APP_VERSION: string
  // #2299: snapshot claims are honoured only once this is set and the desktop
  // `min_write_version` is at or above it (07 §7.7.1). Unset in wrangler.toml
  // for every environment; set during the rollout.
  CRDT_CLAIM_MIN_DESKTOP_VERSION?: string
  RECOVERY_DUMMY_SECRET: string
  WEBHOOK_HMAC_KEY: string
  PADDLE_WEBHOOK_SECRET: string
  PADDLE_CHECKOUT_TOKEN_SECRET: string
  PADDLE_API_KEY?: string
  PADDLE_ENVIRONMENT?: string
  // Recurring price ids, needed to switch an existing subscription's plan/cadence.
  // Same values the landing checkout uses; absent → change-plan reports 503.
  PADDLE_PRICE_PLUS_MONTHLY?: string
  PADDLE_PRICE_PLUS_ANNUAL?: string
  PADDLE_PRICE_PRO_MONTHLY?: string
  PADDLE_PRICE_PRO_ANNUAL?: string
  TELEMETRY_HMAC_KEY: string
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
  GITHUB_TOKEN?: string
  // R2 presign (direct-to-R2 attachment transfers, #1836). All four optional:
  // absent/incomplete → presign endpoints degrade to a typed "unavailable" and
  // clients fall back to the proxied blob paths. Never commit real values.
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  R2_S3_ENDPOINT?: string
  R2_S3_BUCKET?: string
  // Bootstrap session signing key (#1837). Optional like the presign set:
  // absent → the bootstrap endpoints answer a typed 501 and rate-limit
  // elevation returns null everywhere, so unconfigured deployments behave
  // exactly as before. Never commit real values.
  BOOTSTRAP_SESSION_HMAC_KEY?: string
  // Pack compaction queue (#1839). Optional so local dev without Queues keeps
  // working: an absent binding makes enqueuePackCompaction a no-op and the
  // cron backfill still drains packs over time.
  PACK_QUEUE?: Queue<import('./services/pack-compaction').PackCompactionMessageBody>
  fetch?: typeof fetch
}

export type AppContext = {
  Bindings: Bindings
  Variables: {
    userId?: string
    deviceId?: string
    tokenJti?: string
    sessionNonce?: string
    vaultId?: string
    syncEntitlement?: import('./services/entitlements').SyncEntitlement
    syncSubscription?: SyncSubscription
    client?: import('./lib/client-identity').ClientIdentity
  }
}
