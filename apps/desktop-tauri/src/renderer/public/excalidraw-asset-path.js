// Excalidraw reads window.EXCALIDRAW_ASSET_PATH at module-eval time to locate
// its self-hosted assets (fonts are requested from <base>/fonts/...). The value
// must be a fully-qualified URL: relative or '/'-rooted values are resolved
// against window.location.origin, which is not a usable base under the packaged
// app's file:// origin. Fonts ship in public/excalidraw/fonts (copied verbatim
// from @excalidraw/excalidraw/dist/prod/fonts); the CSP (font-src 'self')
// blocks Excalidraw's CDN fallback, so these local files are the only source.
window.EXCALIDRAW_ASSET_PATH = new URL('excalidraw/', window.location.href).href
