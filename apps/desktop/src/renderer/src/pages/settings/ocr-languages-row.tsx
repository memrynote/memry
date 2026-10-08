import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Locale } from '@memry/contracts/locale-api'
import {
  BUNDLED_OCR_LANGUAGE,
  OCR_LANGUAGE_BY_LOCALE,
  type OcrLanguage,
  type OcrLanguagesState
} from '@memry/contracts/ocr-languages-api'
import { useT } from '@memry/i18n/renderer'
import { LOCALE_DISPLAY_NAMES, SUPPORTED_LOCALES } from '@memry/i18n/shared'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { SettingRow, COMPACT_SELECT } from '@/components/settings/settings-primitives'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'

const log = createLogger('OcrLanguagesRow')

/** Each OCR language under the native name of the UI locale it belongs to. */
const LANGUAGE_NAMES = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale: Locale) => [
    OCR_LANGUAGE_BY_LOCALE[locale],
    LOCALE_DISPLAY_NAMES[locale]
  ])
) as Record<OcrLanguage, string>

const LANGUAGES = SUPPORTED_LOCALES.map((locale: Locale) => OCR_LANGUAGE_BY_LOCALE[locale])

function useOcrLanguages(): OcrLanguagesState | null {
  const [state, setState] = useState<OcrLanguagesState | null>(null)
  useEffect(() => {
    let live = true
    window.api.ocrLanguages
      .get()
      .then((next) => {
        if (live) setState(next)
      })
      .catch((error: unknown) => log.error('Failed to read OCR languages', error))
    const unsubscribe = window.api.onOcrLanguagesChanged(setState)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  return state
}

/** Settings > General: the languages OCR reads, and where their downloads stand. */
export function OcrLanguagesRow() {
  const { t } = useT('settings')
  const state = useOcrLanguages()
  if (!state) return null

  const selected = new Set(state.selected)
  const names = state.selected.map((lang) => LANGUAGE_NAMES[lang])
  const summary =
    names.length > 2
      ? t('general.ocrLanguages.more', {
          names: names.slice(0, 2).join(', '),
          count: names.length - 2
        })
      : names.join(', ')

  const choose = async (lang: OcrLanguage, checked: boolean): Promise<void> => {
    const next = state.selected.filter((code) => code !== lang)
    try {
      await window.api.ocrLanguages.set({ languages: checked ? [...next, lang] : next })
    } catch (error) {
      log.error('Failed to set OCR languages', error)
      toast.error(extractErrorMessage(error, t('general.ocrLanguages.saveFailed')))
    }
  }

  const retry = async (): Promise<void> => {
    try {
      await window.api.ocrLanguages.retry()
    } catch (error) {
      log.error('Failed to retry OCR language downloads', error)
      toast.error(extractErrorMessage(error, t('general.ocrLanguages.saveFailed')))
    }
  }

  const notices = state.selected.flatMap((lang) => {
    const status = state.statuses[lang]
    if (status?.state === 'downloading') {
      const percent = Math.floor((status.receivedBytes / status.totalBytes) * 100)
      return [
        {
          lang,
          failed: false,
          text: t('general.ocrLanguages.downloading', { language: LANGUAGE_NAMES[lang], percent })
        }
      ]
    }
    if (status?.state === 'failed') {
      const reason = extractErrorMessage(status.error, t('general.ocrLanguages.failed'))
      return [
        {
          lang,
          failed: true,
          text: t('general.ocrLanguages.failedWith', { language: LANGUAGE_NAMES[lang], reason })
        }
      ]
    }
    return []
  })

  return (
    <div data-testid="ocr-languages-setting">
      <SettingRow
        label={t('general.ocrLanguages.label')}
        description={t('general.ocrLanguages.helper')}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className={cn(COMPACT_SELECT, 'max-w-48 truncate')}
              data-testid="ocr-languages-trigger"
            >
              {summary}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
            {LANGUAGES.map((lang) => (
              <DropdownMenuCheckboxItem
                key={lang}
                checked={selected.has(lang)}
                disabled={lang === BUNDLED_OCR_LANGUAGE}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => void choose(lang, checked === true)}
              >
                {LANGUAGE_NAMES[lang]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SettingRow>
      {notices.length > 0 && (
        <div className="flex flex-col gap-1.5 pb-2.5" role="status" aria-live="polite">
          {notices.map((notice) => (
            <div key={notice.lang} className="flex items-center justify-between gap-3">
              <span
                className={cn(
                  'text-xs/4',
                  notice.failed ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {notice.text}
              </span>
              {notice.failed && (
                <Button size="sm" variant="outline" onClick={() => void retry()}>
                  {t('general.ocrLanguages.retry')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
