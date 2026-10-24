import type { SectionType } from '@/lib/section-visibility'

/**
 * Get default collapsed empty section props for a section type.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch over a closed union; a default branch would hide new members from the compiler
export const getCollapsedEmptyProps = (type: SectionType): { label: string; message: string } => {
  switch (type) {
    case 'today':
      return { label: 'TODAY', message: 'All clear!' }
    case 'tomorrow':
      return { label: 'TOMORROW', message: 'No tasks' }
    case 'upcoming':
      return { label: 'UPCOMING', message: 'Nothing scheduled' }
    case 'overdue':
      return { label: 'OVERDUE', message: 'All caught up!' }
    case 'no-date':
      return { label: 'NO DATE', message: 'No tasks' }
  }
}
