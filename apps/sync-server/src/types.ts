export type Bindings = {
  DB: D1Database
  STORAGE: R2Bucket
  USER_SYNC_STATE: DurableObjectNamespace
  LINKING_SESSION: DurableObjectNamespace
  PRODUCT_TELEMETRY: AnalyticsEngineDataset
  ENVIRONMENT: string
  ALLOWED_ORIGIN?: string
  JWT_PUBLIC_KEY: string
  JWT_PRIVATE_KEY: string
  RESEND_API_KEY: string
  OTP_HMAC_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GOOGLE_REDIRECT_URI: string
  MIN_APP_VERSION: string
  RECOVERY_DUMMY_SECRET: string
  WEBHOOK_HMAC_KEY: string
  PADDLE_WEBHOOK_SECRET: string
  PADDLE_CHECKOUT_TOKEN_SECRET: string
  TELEMETRY_HMAC_KEY: string
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
  }
}
