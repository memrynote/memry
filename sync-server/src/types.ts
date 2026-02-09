export type Bindings = {
  DB: D1Database
  STORAGE: R2Bucket
  USER_SYNC_STATE: DurableObjectNamespace
  LINKING_SESSION: DurableObjectNamespace
  ENVIRONMENT: string
  ALLOWED_ORIGIN?: string
  JWT_SIGNING_KEY: string
  RESEND_API_KEY: string
}

export type AppContext = {
  Bindings: Bindings
  Variables: {
    userId?: string
    deviceId?: string
  }
}
