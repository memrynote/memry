import { defineConfig } from 'wxt'
import tailwindcss from '@tailwindcss/vite'

// ponytail: no manifest `key` — dev unpacked ID is stable while the .output path is stable, so pairing survives reloads.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: {
    name: 'Memry Web Clipper',
    description: 'Save the page you are reading to Memry as a readable note.',
    permissions: ['storage', 'activeTab', 'alarms'],
    host_permissions: ['http://127.0.0.1/*'],
    commands: {
      'capture-page': {
        suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
        description: 'Capture this page to Memry'
      }
    }
  },
  vite: () => ({
    plugins: [tailwindcss()]
  })
})
