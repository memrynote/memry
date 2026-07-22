import { describe, expect, it } from 'vitest'
import { decideFrameNavigation } from './frame-navigation'

const PROD_APP_URL = 'file:///Applications/MemryNote.app/Contents/Resources/app/renderer/index.html'
const DEV_APP_URL = 'http://localhost:5173/'

const prodMain = { isMainFrame: true, currentUrl: PROD_APP_URL, isDev: false }
const devMain = { isMainFrame: true, currentUrl: DEV_APP_URL, isDev: true }
const prodSub = { isMainFrame: false, currentUrl: PROD_APP_URL, isDev: false }

describe('decideFrameNavigation', () => {
  describe('main frame — app origin stays in-window', () => {
    it('allows reloading the app document in prod (file:// same path)', () => {
      expect(decideFrameNavigation(PROD_APP_URL, prodMain)).toBe('allow')
    })

    it('allows hash-only changes (in-app routing) in prod', () => {
      expect(
        decideFrameNavigation(`${PROD_APP_URL}#/notes/abc`, {
          ...prodMain,
          currentUrl: `${PROD_APP_URL}#/home`
        })
      ).toBe('allow')
    })

    it('allows hash-only changes on the dev server URL', () => {
      expect(
        decideFrameNavigation(`${DEV_APP_URL}#/quick-capture`, {
          ...devMain,
          currentUrl: `${DEV_APP_URL}#/home`
        })
      ).toBe('allow')
    })

    it('denies file:// navigation to a different local document', () => {
      expect(decideFrameNavigation('file:///etc/passwd', prodMain)).toBe('deny')
      expect(decideFrameNavigation('file:///tmp/evil.html', prodMain)).toBe('deny')
    })
  })

  describe('main frame — dev server (HMR/localhost)', () => {
    it('allows same-origin dev server navigation in dev', () => {
      expect(decideFrameNavigation('http://localhost:5173/index.html', devMain)).toBe('allow')
    })

    it('denies localhost navigation in prod instead of opening it externally', () => {
      expect(decideFrameNavigation('http://localhost:5173/', prodMain)).toBe('deny')
      expect(decideFrameNavigation('http://127.0.0.1:8080/admin', prodMain)).toBe('deny')
    })

    it('denies loopback origins that do not match the dev server, even in dev', () => {
      expect(decideFrameNavigation('http://localhost:9999/', devMain)).toBe('deny')
      expect(decideFrameNavigation('http://127.0.0.1:9999/', devMain)).toBe('deny')
      expect(decideFrameNavigation('http://[::1]:9999/', devMain)).toBe('deny')
    })
  })

  describe('main frame — external URLs re-route through the OS', () => {
    it('opens external https links in the default browser', () => {
      expect(decideFrameNavigation('https://example.com/page', prodMain)).toBe('open-external')
      expect(decideFrameNavigation('https://example.com/page', devMain)).toBe('open-external')
    })

    it('opens external http links in the default browser', () => {
      expect(decideFrameNavigation('http://example.com/', prodMain)).toBe('open-external')
    })

    it('opens mailto links externally', () => {
      expect(decideFrameNavigation('mailto:hi@memrynote.com', prodMain)).toBe('open-external')
    })
  })

  describe('memry-file custom scheme', () => {
    it('hands a main-frame memry-file navigation to the OS instead of navigating (would trap the app)', () => {
      expect(decideFrameNavigation('memry-file://local/Users/kaan/vault/file.pdf', prodMain)).toBe(
        'open-file'
      )
      expect(decideFrameNavigation('memry-file://local/Users/kaan/vault/image.png', devMain)).toBe(
        'open-file'
      )
    })

    it('still allows memry-file in subframes (protocol handler enforces its own path allowlist)', () => {
      expect(decideFrameNavigation('memry-file://local/Users/kaan/vault/file.pdf', prodSub)).toBe(
        'allow'
      )
    })
  })

  describe('subframes — embeds keep working, dangerous schemes stay out', () => {
    it('allows the youtube-nocookie embed frame to navigate', () => {
      expect(
        decideFrameNavigation('https://www.youtube-nocookie.com/embed/xyz?autoplay=1', prodSub)
      ).toBe('allow')
    })

    it('allows subframe http(s) navigation to other origins (CSP frame-src is the origin gate)', () => {
      expect(decideFrameNavigation('https://example.com/widget', prodSub)).toBe('allow')
    })

    it('allows about:blank / about:srcdoc frame initialization', () => {
      expect(decideFrameNavigation('about:blank', prodSub)).toBe('allow')
      expect(decideFrameNavigation('about:srcdoc', prodSub)).toBe('allow')
    })

    it('denies file:// subframes', () => {
      expect(decideFrameNavigation('file:///etc/passwd', prodSub)).toBe('deny')
    })

    it('denies javascript: and data: subframes', () => {
      expect(decideFrameNavigation('javascript:alert(1)', prodSub)).toBe('deny')
      expect(decideFrameNavigation('data:text/html,<script>1</script>', prodSub)).toBe('deny')
    })
  })

  describe('dangerous or unknown schemes never leave the app or reach the OS', () => {
    it('denies javascript: in the main frame', () => {
      expect(decideFrameNavigation('javascript:alert(1)', prodMain)).toBe('deny')
      expect(decideFrameNavigation('javascript:alert(1)', devMain)).toBe('deny')
    })

    it('denies data: and blob: in the main frame', () => {
      expect(decideFrameNavigation('data:text/html,<h1>x</h1>', prodMain)).toBe('deny')
      expect(decideFrameNavigation('blob:file:///abc-123', prodMain)).toBe('deny')
    })

    it('denies about: in the main frame (stays pinned to the app document)', () => {
      expect(decideFrameNavigation('about:blank', prodMain)).toBe('deny')
    })

    it('denies the memry: deep-link scheme (OS/main process handles it, not renderer nav)', () => {
      expect(decideFrameNavigation('memry://auth/callback?code=x', prodMain)).toBe('deny')
    })

    it('denies arbitrary custom protocols instead of opening them', () => {
      expect(decideFrameNavigation('smb://host/share', prodMain)).toBe('deny')
      expect(decideFrameNavigation('vscode://open?url=x', prodMain)).toBe('deny')
    })

    it('denies malformed and empty URLs', () => {
      expect(decideFrameNavigation('not a url', prodMain)).toBe('deny')
      expect(decideFrameNavigation('', prodMain)).toBe('deny')
      expect(decideFrameNavigation('not a url', prodSub)).toBe('deny')
    })
  })

  describe('missing or unparseable current URL (before first load)', () => {
    it('still routes external https through the OS', () => {
      expect(
        decideFrameNavigation('https://example.com/', {
          isMainFrame: true,
          currentUrl: '',
          isDev: false
        })
      ).toBe('open-external')
    })

    it('still denies file:// and loopback targets', () => {
      expect(
        decideFrameNavigation('file:///etc/passwd', {
          isMainFrame: true,
          currentUrl: '',
          isDev: false
        })
      ).toBe('deny')
      expect(
        decideFrameNavigation('http://localhost:5173/', {
          isMainFrame: true,
          currentUrl: '',
          isDev: true
        })
      ).toBe('deny')
    })
  })
})
