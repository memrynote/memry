export const memryLinkClassName =
  'text-[#81B4E5] hover:underline hover:decoration-dotted underline-offset-2'

/**
 * Inline citation chip: an agent link that the turn also listed as a source
 * renders as a compact pill in the sentence it backs, not as running text.
 */
export const memryLinkChipClassName =
  'agent-source-chip me-1 inline-flex h-[1.125rem] max-w-[11rem] -translate-y-px items-center gap-1 rounded-[5px] border border-border bg-muted px-[3px] align-middle text-[10.5px] leading-none text-muted-foreground no-underline transition-colors duration-150 hover:bg-accent hover:text-foreground hover:no-underline'

/** Longer titles stop reading as a chip and start wrapping the line. */
export const MEMRY_LINK_CHIP_MAX_LABEL = 20
