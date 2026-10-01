/**
 * Stands in for `electron` when seed-vault.ts loads main modules through
 * Vite's module runner (see `loadWritingDraftsStore` there). Inlined, so every
 * named import from it reads undefined instead of failing to link.
 */
export default {}
