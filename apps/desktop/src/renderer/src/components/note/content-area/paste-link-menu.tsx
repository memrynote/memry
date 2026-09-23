import { memo } from 'react'
import { Link, Play, Globe, Bookmark, type AppIcon } from '@/lib/icons'
import type { PasteLinkOption } from './hooks/use-paste-link-menu'
import { useT } from '@memry/i18n/renderer'
import { InlineChoiceMenu } from './inline-choice-menu'

const OPTION_CONFIG: Record<PasteLinkOption, { icon: AppIcon; labelKey: string }> = {
  mention: { icon: Link, labelKey: 'menus.pasteLink.mention' },
  embed: { icon: Play, labelKey: 'menus.pasteLink.embedVideo' },
  bookmark: { icon: Bookmark, labelKey: 'menus.pasteLink.bookmark' },
  url: { icon: Globe, labelKey: 'menus.pasteLink.url' }
}

interface PasteLinkMenuProps {
  isOpen: boolean
  position: { x: number; y: number }
  options: PasteLinkOption[]
  selectedIndex: number
  onSelect: (option: PasteLinkOption) => void
}

export const PasteLinkMenu = memo(
  ({ isOpen, position, options, selectedIndex, onSelect }: PasteLinkMenuProps) => {
    const { t } = useT('notes')

    if (!isOpen) return null

    return (
      <InlineChoiceMenu
        title={t('menus.pasteLink.title')}
        position={position}
        options={options.map((option) => ({
          id: option,
          icon: OPTION_CONFIG[option].icon,
          label: t(OPTION_CONFIG[option].labelKey)
        }))}
        selectedIndex={selectedIndex}
        onSelect={onSelect}
      />
    )
  }
)

PasteLinkMenu.displayName = 'PasteLinkMenu'
