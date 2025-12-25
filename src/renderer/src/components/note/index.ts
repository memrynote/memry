export { NoteLayout } from './note-layout'
export { OutlineEdge } from './outline-edge'
export { RightSidebar } from './right-sidebar'
export type { HeadingItem } from './note-layout'

// Content Area
export { ContentArea } from './content-area'
export type { ContentAreaProps, HeadingInfo, SelectionInfo, Block } from './content-area'

// Related Notes
export { RelatedNotesTab } from './related-notes'
export type { RelatedNote, ReferencedNote, RelatedNotesTabProps } from './related-notes'

// Re-export shared outline panel for convenience
export { OutlineInfoPanel, type DocumentStats } from '@/components/shared'
