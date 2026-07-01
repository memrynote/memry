import { useSyncExternalStore } from 'react'

export type DetectedOS = 'mac' | 'windows' | 'linux' | null
export type DownloadPlatform = 'mac-arm64' | 'mac-x64' | 'windows' | 'linux' | 'linux-deb'

export function detectOS(): DetectedOS {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent
  if (/Mac/i.test(ua)) return 'mac'
  if (/Win/i.test(ua)) return 'windows'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return null
}

const subscribeOS = () => () => {}
const getServerOS = (): DetectedOS => null

export function useDetectedOS(): DetectedOS {
  return useSyncExternalStore(subscribeOS, detectOS, getServerOS)
}

export function downloadHref(platform: DownloadPlatform): string {
  return `/api/download?platform=${platform}`
}

// ponytail: navigator can't tell Apple Silicon from Intel — default mac to arm64
// and surface an explicit Intel link on the download page.
export function platformForOS(os: DetectedOS): DownloadPlatform | null {
  if (os === 'mac') return 'mac-arm64'
  if (os === 'windows') return 'windows'
  if (os === 'linux') return 'linux'
  return null
}

export function osLabel(os: DetectedOS): string {
  if (os === 'mac') return 'macOS'
  if (os === 'windows') return 'Windows'
  if (os === 'linux') return 'Linux'
  return ''
}
