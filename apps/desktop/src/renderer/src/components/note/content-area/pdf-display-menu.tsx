import { FileText, Link } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import { InlineChoiceMenu } from './inline-choice-menu'
import { PDF_DISPLAY_OPTIONS, type PdfDisplayOption } from './hooks/use-pdf-display-menu'

const OPTION_CONFIG = {
  embed: { icon: FileText, labelKey: 'menus.pdfDisplay.embed' },
  link: { icon: Link, labelKey: 'menus.pdfDisplay.link' }
} as const

interface PdfDisplayMenuProps {
  state: { position: { x: number; y: number }; selectedIndex: number } | null
  onSelect: (option: PdfDisplayOption) => void
}

/** "Show as" Embedded / Link for a PDF just dropped into a note; keyboard lives in the hook. */
export function PdfDisplayMenu({ state, onSelect }: PdfDisplayMenuProps) {
  const { t } = useT('notes')
  if (!state) return null

  return (
    <InlineChoiceMenu
      title={t('menus.pdfDisplay.title')}
      position={state.position}
      options={PDF_DISPLAY_OPTIONS.map((option) => ({
        id: option,
        icon: OPTION_CONFIG[option].icon,
        label: t(OPTION_CONFIG[option].labelKey)
      }))}
      selectedIndex={state.selectedIndex}
      onSelect={onSelect}
    />
  )
}
