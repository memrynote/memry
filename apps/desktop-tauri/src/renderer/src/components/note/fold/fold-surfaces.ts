export interface FoldSurfaces {
  overlay: boolean
  editor: boolean
  /** Which surface fades in on top of the other during the crossfade. */
  incoming: 'overlay' | 'editor' | null
}

/** Duration of the crossfade; reduced motion skips it. */
export const FOLD_CROSSFADE_MS = 150

/**
 * Which surfaces are mounted visible. While settling, both are: the incoming
 * one fades in over the outgoing one. Reduced motion never settles, so the swap
 * is instant.
 */
export function surfacesFor(folded: boolean, settling: boolean): FoldSurfaces {
  if (folded) return { overlay: true, editor: settling, incoming: settling ? 'overlay' : null }
  return { overlay: settling, editor: true, incoming: settling ? 'editor' : null }
}
