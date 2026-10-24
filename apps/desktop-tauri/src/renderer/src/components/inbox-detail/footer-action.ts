/**
 * Sizing for the inbox detail footer buttons. Shared by the panel (Archive,
 * File, Restore, Delete) and the convert forms, whose submit is portalled into
 * the same footer, so every button there reads at the panel's 13px text size.
 * Kept out of `convert-actions.tsx` because panel tests mock that module.
 */
export const FOOTER_ACTION_CLASS = 'h-8 px-3 gap-1.5 text-[13px] [&_svg]:size-3.5'
