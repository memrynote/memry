import { defineConfig } from 'wxt'
import tailwindcss from '@tailwindcss/vite'

// ponytail: no manifest `key` — dev unpacked ID is stable while the .output path is stable, so pairing survives reloads.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: {
    name: 'Memrynote Web Clipper',
    description: 'Save the page you are reading to Memrynote as a readable note.',
    permissions: ['storage', 'activeTab', 'alarms'],
    host_permissions: ['http://127.0.0.1/*'],
    // Optional, so it shows no install-time warning: the popup requests just the
    // PDF's own origin on the Send click, per site. Needed to re-fetch a PDF tab
    // with the user's cookies, since content scripts never run in a PDF viewer.
    optional_host_permissions: ['*://*/*'],
    commands: {
      'capture-page': {
        suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
        description: 'Capture this page to Memrynote'
      }
    },
    // ponytail: stable gecko id → storage.local pairing token survives reloads; required for AMO.
    // Firefox builds target MV3 (--mv3) so browser.action/host_permissions match the Chrome source unchanged.
    browser_specific_settings: {
      // min versions = where data_collection_permissions is honored (FF 140 / Android 142),
      // not where MV3 starts — avoids the AMO "key ignored below this version" warning.
      gecko: {
        id: 'web-clipper@memrynote.com',
        strict_min_version: '140.0',
        // AMO requires this for new add-ons (since 2025-11-03). Captures go only to the
        // user's own desktop app on 127.0.0.1 — nothing is collected by the developer.
        data_collection_permissions: { required: ['none'] }
      },
      gecko_android: {
        strict_min_version: '142.0'
      }
    }
  },
  vite: () => ({
    plugins: [tailwindcss()]
  })
})
