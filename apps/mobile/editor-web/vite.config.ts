import { defineConfig } from 'vite'

/**
 * The WebView editor bundle (spec 001-mobile-app T057).
 *
 * Output is ONE self-contained HTML file: the contract requires no network at
 * editor open, and Metro cannot serve a directory of chunks into a WKWebView
 * anyway. Everything therefore inlines — a single entry chunk, assets as data
 * URIs, CSS folded in by the post-build step in `scripts/build-editor-web.mjs`.
 */
export default defineConfig({
  build: {
    target: 'safari16',
    // The reference device is iOS; sourcemaps would double the asset size for
    // a surface whose errors already come back over the `err` bridge message.
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'editor.js',
        assetFileNames: 'editor.[ext]'
      }
    }
  },
  // `define` rather than an import so the value is frozen into the asset: the
  // freshness gate compares what the bundle CLAIMS against what the sources
  // hash to, and a build-time import would just recompute agreement.
  define: {
    __EDITOR_WEB_CONTRACT_HASH__: JSON.stringify(process.env.EDITOR_WEB_CONTRACT_HASH ?? 'dev')
  }
})
