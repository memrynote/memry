// jsdom for the HTML importers, reached only through
// `await import('../_shared/lazy-jsdom')` so it stays out of the main process
// startup set (the importer registry itself loads at launch).
//
// A bundled module rather than `await import('jsdom')` at the call sites:
// jsdom is external, and rollup keeps an external dynamic import as a native
// ESM `import()`, which would resolve jsdom through Node's ESM loader inside
// app.asar. Through this module the bundle loads it with the same CJS
// `require('jsdom')` it always used, just later.
export { JSDOM } from 'jsdom'
