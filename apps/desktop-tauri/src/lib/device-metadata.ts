// Browser/WebView-only device metadata helpers used by the QR linking
// flow. Both the scan side (`linking-code-entry`) and the completion
// side (`linking-pending`) need to report these to Rust so
// `/auth/devices` records consistent values.

const FALLBACK_DEVICE_NAME = 'Memry Desktop'

export function localDeviceName(): string {
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    const match = navigator.userAgent.match(/\(([^)]+)\)/)
    if (match?.[1]) return match[1].split(';')[0]?.trim() || FALLBACK_DEVICE_NAME
  }
  return FALLBACK_DEVICE_NAME
}

export function localDevicePlatform(): string {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac os')) return 'macos'
  if (ua.includes('windows')) return 'windows'
  if (ua.includes('linux')) return 'linux'
  return 'desktop'
}

// Tauri exposes the app version through `@tauri-apps/api/app`, but the
// linking flow needs a synchronous string for the IPC payload. We
// expose a small helper so callers can pre-fetch the version at app
// boot and feed it into `localAppVersion`. Until that wiring lands,
// fall back to the hard-coded crate version published in the Cargo
// manifest (`2.0.0-alpha.1`); the server only stores this value for
// device-list display so a stale string is not a security issue.
const FALLBACK_APP_VERSION = '2.0.0-alpha.1'

let cachedAppVersion: string | null = null

export function setLocalAppVersion(version: string): void {
  cachedAppVersion = version
}

export function localAppVersion(): string {
  return cachedAppVersion ?? FALLBACK_APP_VERSION
}
