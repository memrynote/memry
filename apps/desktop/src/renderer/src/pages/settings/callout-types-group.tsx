import { useState } from 'react'
import { toast } from 'sonner'
import {
  CALLOUT_ICON_MAX_LENGTH,
  CALLOUT_LABEL_MAX_LENGTH,
  CALLOUT_TYPE_NAME_REGEX,
  isBuiltInCalloutType,
  type CalloutTypeDefinition
} from '@memry/editor-schema/blocks'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsGroup } from '@/components/settings/settings-primitives'
import {
  CALLOUT_ICON_IDS,
  DEFAULT_CALLOUT_ICON,
  calloutIcon
} from '@/components/note/content-area/callout-icons'
import { useCalloutTypes } from '@/components/note/content-area/callout-types-store'
import { Pencil, Plus, Trash } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'

const EMPTY: CalloutTypeDefinition = {
  name: '',
  label: '',
  color: '#3b82f6',
  icon: DEFAULT_CALLOUT_ICON
}

type Draft = { definition: CalloutTypeDefinition; isNew: boolean }

export function CalloutTypesGroup() {
  const { t } = useT('settings')
  const types = useCalloutTypes()
  const [draft, setDraft] = useState<Draft | null>(null)

  const save = async (next: CalloutTypeDefinition[]): Promise<boolean> => {
    try {
      const result = await window.api.settings.setCalloutTypes(next)
      if (result.success) return true
      toast.error(result.error ?? t('editor.calloutTypes.error'))
    } catch (err) {
      toast.error(extractErrorMessage(err, t('editor.calloutTypes.error')))
    }
    return false
  }

  const nameError = (definition: CalloutTypeDefinition): string | null => {
    if (!CALLOUT_TYPE_NAME_REGEX.test(definition.name)) return t('editor.calloutTypes.nameInvalid')
    if (isBuiltInCalloutType(definition.name)) return t('editor.calloutTypes.nameBuiltIn')
    if (draft?.isNew && types.some((existing) => existing.name === definition.name)) {
      return t('editor.calloutTypes.nameTaken')
    }
    return null
  }

  const submit = async () => {
    if (!draft) return
    const definition = {
      ...draft.definition,
      label: draft.definition.label.trim() || draft.definition.name
    }
    const others = types.filter((existing) => existing.name !== definition.name)
    if (await save([...others, definition])) setDraft(null)
  }

  const error = draft ? nameError(draft.definition) : null
  const edit = (patch: Partial<CalloutTypeDefinition>) =>
    setDraft(
      (current) => current && { ...current, definition: { ...current.definition, ...patch } }
    )

  return (
    <SettingsGroup
      label={t('editor.groups.calloutTypes')}
      description={t('editor.calloutTypes.description')}
      action={
        !draft && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft({ definition: EMPTY, isNew: true })}
          >
            <Plus aria-hidden />
            {t('editor.calloutTypes.add')}
          </Button>
        )
      }
    >
      {types.length === 0 && !draft && (
        <p className="py-3 text-xs/4 text-muted-foreground">{t('editor.calloutTypes.empty')}</p>
      )}
      {types.map((definition) => {
        const Icon = calloutIcon(definition.icon)
        return (
          <div key={definition.name} className="flex min-h-11 items-center gap-3 py-2.5">
            <span style={{ color: definition.color }} className="flex size-5 items-center">
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px]/4 text-foreground">{definition.label}</span>
              <code className="text-xs/4 text-muted-foreground">{`> [!${definition.name}]`}</code>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('editor.calloutTypes.edit', { name: definition.label })}
              onClick={() => setDraft({ definition, isNew: false })}
            >
              <Pencil aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('editor.calloutTypes.delete', { name: definition.label })}
              onClick={() =>
                void save(types.filter((existing) => existing.name !== definition.name))
              }
            >
              <Trash aria-hidden />
            </Button>
          </div>
        )
      })}
      {draft && (
        <form
          className="flex flex-col gap-3 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!error) void submit()
          }}
        >
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1 text-xs/4 text-muted-foreground">
              {t('editor.calloutTypes.name')}
              <Input
                value={draft.definition.name}
                disabled={!draft.isNew}
                maxLength={32}
                placeholder={t('editor.calloutTypes.namePlaceholder')}
                onChange={(event) => edit({ name: event.target.value.toLowerCase() })}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs/4 text-muted-foreground">
              {t('editor.calloutTypes.label')}
              <Input
                value={draft.definition.label}
                maxLength={CALLOUT_LABEL_MAX_LENGTH}
                onChange={(event) => edit({ label: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs/4 text-muted-foreground">
              {t('editor.calloutTypes.color')}
              <input
                type="color"
                value={draft.definition.color}
                className="h-7.5 w-12 cursor-pointer rounded-[7px] border border-input bg-transparent"
                onChange={(event) => edit({ color: event.target.value })}
              />
            </label>
          </div>
          {draft.definition.name !== '' && error && (
            <p className="text-xs/4 text-destructive">{error}</p>
          )}
          <div
            role="radiogroup"
            aria-label={t('editor.calloutTypes.icon')}
            className="flex flex-wrap gap-1"
          >
            {CALLOUT_ICON_IDS.filter((id) => id.length <= CALLOUT_ICON_MAX_LENGTH).map((id) => {
              const Icon = calloutIcon(id)
              const selected = draft.definition.icon === id
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={id}
                  className={cn(
                    'flex size-8 items-center justify-center rounded-md border',
                    selected ? 'border-ring bg-accent' : 'border-transparent hover:bg-accent'
                  )}
                  onClick={() => edit({ icon: id })}
                >
                  <Icon className="size-4" style={{ color: draft.definition.color }} aria-hidden />
                </button>
              )
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('editor.calloutTypes.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={error !== null}>
              {t('editor.calloutTypes.save')}
            </Button>
          </div>
        </form>
      )}
    </SettingsGroup>
  )
}
