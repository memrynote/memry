/**
 * "Lay out by property": pick a select, multi-select or status property and
 * the board gets one bound frame per value, with the cards already on it
 * sorted in. The placement itself is the caller's; this only picks.
 */

import React from 'react'
import { Command } from 'cmdk'
import { useT } from '@memry/i18n/renderer'
import { LayoutGrid } from '@/lib/icons'
import { useFrameBindingChoices, type BindableProperty } from './use-frame-binding-choices'

export interface CanvasFrameLayoutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (property: BindableProperty) => void
}

export function CanvasFrameLayoutDialog({
  open,
  onOpenChange,
  onPick
}: CanvasFrameLayoutDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const { properties, loading } = useFrameBindingChoices(open)

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={t('canvas.frame.layoutTitle')}
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      className="fixed start-1/2 top-24 z-50 w-[28rem] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-lg rtl:translate-x-1/2"
    >
      <div className="border-b border-border px-3 pt-3 pb-2">
        <p className="text-sm font-medium text-foreground">{t('canvas.frame.layoutTitle')}</p>
        <p className="text-xs text-text-tertiary">{t('canvas.frame.layoutHint')}</p>
      </div>
      <Command.Input
        data-testid="canvas-frame-layout-input"
        placeholder={t('canvas.frame.layoutPlaceholder')}
        className="w-full border-b border-border bg-transparent px-3 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-2 py-6 text-center text-sm text-text-tertiary">
          {loading ? null : t('canvas.frame.layoutEmpty')}
        </Command.Empty>
        {properties.map((property) => (
          <Command.Item
            key={property.name}
            value={property.name}
            data-testid={`canvas-frame-layout-${property.name}`}
            onSelect={() => {
              onPick(property)
              onOpenChange(false)
            }}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted"
          >
            <LayoutGrid className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
            <span className="truncate">{property.name}</span>
            <span className="ms-auto shrink-0 text-xs text-text-tertiary">
              {t('canvas.frame.layoutValueCount', { count: property.values.length })}
            </span>
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
