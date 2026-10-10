import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { isReservedFieldName, type FieldType, type ResolvedTag } from '@memry/contracts/tag-schema'
import type { NewFieldSpec, TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { NEW_FIELD_TYPES } from '@memry/contracts/tag-schema-api'
import { Hash, Link2, Plus } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useEditTagSchema } from '../use-tag-schemas'
import { FIELD_TYPE_ICONS, NEW_FIELD_TYPE_ORDER, fieldTypeLabelKey } from './field-types'
import { RelationFieldCard } from './RelationFieldCard'
import { alternativeFieldName, findPropertyByName } from './settings-logic'
import { useVaultProperties, type VaultProperty } from './use-vault-properties'

interface AddFieldPopoverProps {
  tagKey: string
  tag: ResolvedTag | null
  snapshot: TagSchemaSnapshot | undefined
  disabled?: boolean
}

type Step =
  { kind: 'pick' } | { kind: 'relation'; name: string } | { kind: 'shared'; type: FieldType }

const MAX_EXISTING = 5

function isNewFieldType(type: string): type is NewFieldSpec['type'] {
  return (NEW_FIELD_TYPES as readonly string[]).includes(type)
}

export function AddFieldPopover({
  tagKey,
  tag,
  snapshot,
  disabled
}: AddFieldPopoverProps): React.JSX.Element {
  const { t, i18n } = useT('notes')
  const editSchema = useEditTagSchema()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [busy, setBusy] = useState(false)
  const properties = useVaultProperties(open)
  const tagName = tag?.name ?? tagKey

  const taken = useMemo(
    () => new Set((tag?.effectiveFields ?? []).map((field) => field.name.toLowerCase())),
    [tag]
  )
  const trimmed = name.trim()
  const error = !trimmed
    ? null
    : isReservedFieldName(trimmed)
      ? t('tagFields.settings.addField.reserved', { name: trimmed })
      : taken.has(trimmed.toLowerCase())
        ? t('tagFields.settings.addField.taken', { name: trimmed, tag: tagName })
        : null
  const existing = findPropertyByName(trimmed, properties)
  const matches = trimmed
    ? properties
        .filter(
          (property) =>
            property.name.toLowerCase().includes(trimmed.toLowerCase()) &&
            !taken.has(property.name.toLowerCase())
        )
        .slice(0, MAX_EXISTING)
    : []

  const reset = (): void => {
    setName('')
    setStep({ kind: 'pick' })
  }

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) reset()
  }

  const add = async (field: NewFieldSpec): Promise<void> => {
    setBusy(true)
    try {
      await editSchema({ kind: 'add-field', tag: tagKey, field })
      handleOpenChange(false)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('tagFields.settings.errors.addField')))
    } finally {
      setBusy(false)
    }
  }

  const reuse = (property: VaultProperty): void => {
    void add({ name: property.name, type: isNewFieldType(property.type) ? property.type : 'text' })
  }

  const chooseType = (type: FieldType, fieldName: string, checkShared: boolean): void => {
    if (!fieldName.trim() || error) return
    const match = findPropertyByName(fieldName, properties)
    if (checkShared && match) {
      setName(match.name)
      setStep({ kind: 'shared', type })
      return
    }
    if (type === 'relation') {
      setStep({ kind: 'relation', name: fieldName.trim() })
      return
    }
    void add({ name: fieldName.trim(), type })
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-7 gap-1 px-2 text-xs text-text-secondary"
        >
          <Plus className="size-3.5" />
          {t('tagFields.settings.addField.button')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={cn('p-0', step.kind === 'pick' ? 'w-[280px]' : 'w-[320px] p-4')}
      >
        {step.kind === 'pick' && (
          <div className="flex flex-col">
            <div className="p-2">
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') chooseType('text', name, true)
                }}
                placeholder={t('tagFields.settings.addField.namePlaceholder')}
                aria-label={t('tagFields.settings.addField.namePlaceholder')}
                className="h-8"
              />
              {error && <p className="mt-1.5 px-1 text-xs text-destructive">{error}</p>}
            </div>
            {matches.length > 0 && (
              <>
                <GroupLabel>{t('tagFields.settings.addField.existing')}</GroupLabel>
                <div className="px-1 pb-1">
                  {matches.map((property) => {
                    const Icon = FIELD_TYPE_ICONS[property.type]
                    return (
                      <button
                        key={property.name}
                        type="button"
                        disabled={busy}
                        onClick={() => reuse(property)}
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-start hover:bg-accent"
                      >
                        <Icon className="mt-0.5 size-3.5 shrink-0 text-text-secondary" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate text-sm">{property.name}</span>
                          <span className="text-xs text-text-tertiary">
                            {t('tagFields.settings.addField.existingSub', {
                              type: t(fieldTypeLabelKey(property.type)),
                              count: property.usage
                            })}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="mx-2 border-t" />
              </>
            )}
            <GroupLabel>{t('tagFields.settings.addField.newType')}</GroupLabel>
            <div className="px-1 pb-1">
              {NEW_FIELD_TYPE_ORDER.map((type) => {
                const Icon = FIELD_TYPE_ICONS[type]
                return (
                  <button
                    key={type}
                    type="button"
                    disabled={busy || !trimmed || error !== null}
                    onClick={() => chooseType(type, name, true)}
                    className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-start hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <Icon className="mt-0.5 size-3.5 shrink-0 text-text-secondary" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm">{t(fieldTypeLabelKey(type))}</span>
                      {type === 'relation' && (
                        <span className="text-xs text-text-tertiary">
                          {t('tagFields.settings.addField.relationSub')}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {step.kind === 'relation' && (
          <RelationFieldCard
            name={step.name}
            tagName={tagName}
            initial={null}
            submitLabel={t('tagFields.settings.addField.submit')}
            onCancel={() => handleOpenChange(false)}
            onSubmit={(relation) => add({ name: step.name, type: 'relation', relation })}
          />
        )}

        {step.kind === 'shared' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Hash className="size-4 text-[var(--tint)]" />
              <span className="text-sm font-semibold">
                {t('tagFields.settings.shared.title', { tag: tagName })}
              </span>
            </div>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label={t('tagFields.settings.addField.namePlaceholder')}
              className="h-8"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            {existing && (
              <div className="flex gap-2 rounded-md bg-muted/60 p-3">
                <Link2 className="mt-0.5 size-3.5 shrink-0 text-text-secondary" />
                <div className="flex flex-col items-start gap-2">
                  <p className="text-xs text-text-secondary">
                    <SharedMessage
                      property={existing}
                      tagKey={tagKey}
                      tagName={tagName}
                      snapshot={snapshot}
                      locale={i18n.language}
                    />
                  </p>
                  <button
                    type="button"
                    onClick={() => setName(alternativeFieldName(tagName, existing.name))}
                    className="rounded-full border bg-background px-2.5 py-1 text-xs hover:bg-accent"
                  >
                    {t('tagFields.settings.shared.useInstead', {
                      name: alternativeFieldName(tagName, existing.name)
                    })}
                  </button>
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
                {t('tagFields.settings.cancel')}
              </Button>
              <Button
                size="sm"
                disabled={busy || !trimmed || error !== null}
                onClick={() => {
                  const match = findPropertyByName(name, properties)
                  chooseType(step.type, match?.name ?? name, false)
                }}
              >
                {existing
                  ? t('tagFields.settings.shared.share', { name: existing.name })
                  : t('tagFields.settings.addField.submit')}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
      {children}
    </div>
  )
}

interface SharedMessageProps {
  property: VaultProperty
  tagKey: string
  tagName: string
  snapshot: TagSchemaSnapshot | undefined
  locale: string
}

function SharedMessage({
  property,
  tagKey,
  tagName,
  snapshot,
  locale
}: SharedMessageProps): React.JSX.Element {
  const { t } = useT('notes')
  const options = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    property.options.map((option) => option.value)
  )
  const others = Object.values(snapshot?.tags ?? {})
    .filter(
      (other) =>
        other.key !== tagKey &&
        other.ownFields.some((field) => field.name.toLowerCase() === property.name.toLowerCase())
    )
    .map((other) => other.name)
  const exists = options
    ? t('tagFields.settings.shared.existsWith', { name: property.name, options })
    : t('tagFields.settings.shared.existsAs', {
        name: property.name,
        type: t(fieldTypeLabelKey(property.type))
      })
  const share =
    others.length > 0
      ? t('tagFields.settings.shared.shareWith', {
          tag: tagName,
          others: new Intl.ListFormat(locale, { type: 'conjunction' }).format(others)
        })
      : t('tagFields.settings.shared.shareAny', { tag: tagName })
  return (
    <>
      {exists} {share}
    </>
  )
}
