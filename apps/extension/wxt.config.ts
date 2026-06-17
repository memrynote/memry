import { defineConfig } from 'wxt'
import tailwindcss from '@tailwindcss/vite'

// ponytail: no manifest `key` — dev unpacked ID is stable while the .output path is stable, so pairing survives reloads.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: {
    name: 'Memry Web Clipper',
    description: 'Save the page you are reading to Memry as a readable note.',
    permissions: ['storage', 'activeTab'],
    host_permissions: ['http://127.0.0.1/*']
  },
  vite: () => ({
    plugins: [tailwindcss()]
  })
})
