import { useSyncExternalStore } from 'react'

export type DesktopOS = 'mac' | 'windows' | 'linux'
export type MobileOS = 'ios' | 'android'
export type DetectedOS = DesktopOS | MobileOS | null
export type DownloadPlatform = 'mac-arm64' | 'mac-x64' | 'windows' | 'linux' | 'linux-deb'

export function detectOS(): DetectedOS {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent
  // Phones first: Android UAs contain "Linux" and iPhone UAs contain "Mac OS X".
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  // iPadOS reports a desktop Mac UA, so touch support is the only tell there.
  if (/Mac/i.test(ua) && navigator.maxTouchPoints > 1) return 'ios'
  // Any other phone (KaiOS, Linux phones) fits none of the installers: make no guess.
  if (/Mobile/i.test(ua)) return null
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

export function isMobileOS(os: DetectedOS): os is MobileOS {
  return os === 'ios' || os === 'android'
}

export function downloadHref(platform: DownloadPlatform): string {
  return `/api/download?platform=${platform}`
}

// ponytail: navigator can't tell Apple Silicon from Intel — default mac to arm64
// and surface an explicit Intel link on the download page.
export const DESKTOP_PLATFORM: Record<DesktopOS, DownloadPlatform> = {
  mac: 'mac-arm64',
  windows: 'windows',
  linux: 'linux'
}

export function platformForOS(os: DetectedOS): DownloadPlatform | null {
  return os === null || isMobileOS(os) ? null : DESKTOP_PLATFORM[os]
}

const OS_LABEL: Record<DesktopOS | MobileOS, string> = {
  mac: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android'
}

export function osLabel(os: DetectedOS): string {
  return os === null ? '' : OS_LABEL[os]
}
