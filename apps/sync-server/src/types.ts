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
  WEB_OAUTH_REDIRECT_URI?: string
  MIN_APP_VERSION: string
  RECOVERY_DUMMY_SECRET: string
  WEBHOOK_HMAC_KEY: string
  PADDLE_WEBHOOK_SECRET: string
  PADDLE_CHECKOUT_TOKEN_SECRET: string
  PADDLE_API_KEY?: string
  PADDLE_ENVIRONMENT?: string
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
    syncTypes?: import('@memry/contracts/sync-api').RecordSyncItemType[]
    client?: import('./lib/client-identity').ClientIdentity
  }
}
