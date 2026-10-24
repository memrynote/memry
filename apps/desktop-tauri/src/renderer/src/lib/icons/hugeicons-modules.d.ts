// @hugeicons/core-free-icons ships a module per icon but only a barrel .d.ts, so
// the per-icon subpaths used by hugeicons-subset.ts would otherwise import as `any`.
declare module '@hugeicons/core-free-icons/*' {
  import type { IconSvgElement } from '@hugeicons/react'
  const icon: IconSvgElement
  export default icon
}
