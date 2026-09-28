/**
 * Picks what a canvas frame categorizes its cards as: a tag (typed or
 * existing, nested tags included) or one value of a select, multi-select or
 * status property. Also where a binding is removed.
 *
 * Filtering is ours (`shouldFilter={false}`), matching the other canvas
 * pickers: the rows come from two sources and a typed tag is a row of its own.
 */

import React, { useMemo, useState } from 'react'
import { Command } from 'cmdk'
import { useT } from '@memry/i18n/renderer'
import { Hash, Tag, X } from '@/lib/icons'
import { isValidTagName, normalizeTagName, sanitizeTagInput } from '@/lib/tag-utils'
import { bindingLabel, sameBinding, type FrameBinding } from './canvas-frame-binding'
import { useFrameBindingChoices } from './use-frame-binding-choices'

const MAX_TAG_ROWS = 30
const UNBIND_VALUE = '__unbind__'
const NEW_TAG_VALUE = '__new_tag__'

export interface CanvasFrameBindingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: FrameBinding | null
  onPick: (binding: FrameBinding) => void
  onUnbind: () => void
}

const itemClass =
  'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted'

export function CanvasFrameBindingDialog({
  open,
  onOpenChange,
  current,
  onPick,
  onUnbind
}: CanvasFrameBindingDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const [query, setQuery] = useState('')
  const { tags, properties, loading } = useFrameBindingChoices(open)

  // Every close goes through here, so the next opening starts with an empty
  // query without an effect watching `open`.
  const setOpen = (next: boolean): void => {
    if (!next) setQuery('')
    onOpenChange(next)
  }

  const needle = query.trim().toLowerCase().replace(/^#/, '')

  const typedTag = useMemo(() => {
    const candidate = normalizeTagName(sanitizeTagInput(query.trim()))
    if (!isValidTagName(candidate)) return null
    return tags.some((tag) => tag.toLowerCase() === candidate) ? null : candidate
  }, [query, tags])

  const matchingTags = useMemo(
    () => tags.filter((tag) => tag.toLowerCase().includes(needle)).slice(0, MAX_TAG_ROWS),
    [tags, needle]
  )

  const matchingProperties = useMemo(
    () =>
      properties
        .map((property) => ({
          ...property,
          values: property.values.filter((value) =>
            `${property.name} ${value}`.toLowerCase().includes(needle)
          )
        }))
        .filter((property) => property.values.length > 0),
    [properties, needle]
  )

  const pick = (binding: FrameBinding): void => {
    onPick(binding)
    setOpen(false)
  }

  const nothing =
    !loading && !typedTag && matchingTags.length === 0 && matchingProperties.length === 0

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      shouldFilter={false}
      label={t('canvas.frame.bindTitle')}
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      className="fixed start-1/2 top-24 z-50 w-[32rem] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-lg rtl:translate-x-1/2"
    >
      <div className="border-b border-border px-3 pt-3 pb-2">
        <p className="text-sm font-medium text-foreground">{t('canvas.frame.bindTitle')}</p>
        <p className="text-xs text-text-tertiary">{t('canvas.frame.bindHint')}</p>
      </div>
      <Command.Input
        value={query}
        onValueChange={setQuery}
        data-testid="canvas-frame-binding-input"
        placeholder={t('canvas.frame.bindPlaceholder')}
        className="w-full border-b border-border bg-transparent px-3 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        {current ? (
          <Command.Item
            value={UNBIND_VALUE}
            data-testid="canvas-frame-unbind"
            onSelect={() => {
              onUnbind()
              setOpen(false)
            }}
            className={itemClass}
          >
            <X className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
            <span className="truncate">
              {t('canvas.frame.unbind', { label: bindingLabel(current) })}
            </span>
          </Command.Item>
        ) : null}
        {typedTag ? (
          <Command.Item
            value={NEW_TAG_VALUE}
            data-testid="canvas-frame-new-tag"
            onSelect={() => pick({ kind: 'tag', tag: typedTag })}
            className={itemClass}
          >
            <Hash className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
            <span className="truncate">{t('canvas.frame.useTag', { tag: typedTag })}</span>
          </Command.Item>
        ) : null}
        {nothing ? (
          <div className="px-2 py-6 text-center text-sm text-text-tertiary">
            {t('canvas.frame.bindEmpty')}
          </div>
        ) : null}
        {matchingTags.length > 0 ? (
          <Command.Group heading={t('canvas.frame.groupTags')}>
            {matchingTags.map((tag) => {
              const binding: FrameBinding = { kind: 'tag', tag }
              return (
                <Command.Item
                  key={tag}
                  value={`tag:${tag}`}
                  data-testid={`canvas-frame-tag-${tag}`}
                  onSelect={() => pick(binding)}
                  className={itemClass}
                >
                  <Hash className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                  <span className="truncate">{tag}</span>
                  {sameBinding(current, binding) ? (
                    <span className="ms-auto text-xs text-text-tertiary">
                      {t('canvas.frame.current')}
                    </span>
                  ) : null}
                </Command.Item>
              )
            })}
          </Command.Group>
        ) : null}
        {matchingProperties.map((property) => (
          <Command.Group key={property.name} heading={property.name}>
            {property.values.map((value) => {
              const binding: FrameBinding = {
                kind: 'property',
                property: property.name,
                value,
                propertyType: property.type
              }
              return (
                <Command.Item
                  key={value}
                  value={`prop:${property.name}:${value}`}
                  data-testid={`canvas-frame-prop-${property.name}-${value}`}
                  onSelect={() => pick(binding)}
                  className={itemClass}
                >
                  <Tag className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                  <span className="truncate">{value}</span>
                  {sameBinding(current, binding) ? (
                    <span className="ms-auto text-xs text-text-tertiary">
                      {t('canvas.frame.current')}
                    </span>
                  ) : null}
                </Command.Item>
              )
            })}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
