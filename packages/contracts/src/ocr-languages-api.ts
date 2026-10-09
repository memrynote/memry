import { z } from 'zod'

import { OcrLanguagesChannels } from './ipc-channels'
import type { Locale } from './locale-api'
export { OcrLanguagesChannels }

/**
 * The Tesseract language each UI locale reads in. The sync server serves data
 * for exactly these codes (apps/sync-server/src/lib/ocr-languages.ts).
 */
export const OCR_LANGUAGE_BY_LOCALE = {
  ar: 'ara',
  cs: 'ces',
  da: 'dan',
  de: 'deu',
  el: 'ell',
  en: 'eng',
  es: 'spa',
  fi: 'fin',
  fil: 'fil',
  fr: 'fra',
  he: 'heb',
  hr: 'hrv',
  hu: 'hun',
  id: 'ind',
  it: 'ita',
  ja: 'jpn',
  ko: 'kor',
  ms: 'msa',
  nl: 'nld',
  no: 'nor',
  pl: 'pol',
  pt: 'por',
  ro: 'ron',
  ru: 'rus',
  sk: 'slk',
  sv: 'swe',
  th: 'tha',
  tr: 'tur',
  uk: 'ukr',
  vi: 'vie',
  'zh-CN': 'chi_sim',
  'zh-TW': 'chi_tra'
} as const satisfies Record<Locale, string>

export type OcrLanguage = (typeof OCR_LANGUAGE_BY_LOCALE)[Locale]

export const OCR_LANGUAGES = Object.values(OCR_LANGUAGE_BY_LOCALE) as OcrLanguage[]

/** Ships inside the app and is always read. Every other language is downloaded. */
export const BUNDLED_OCR_LANGUAGE = 'eng' satisfies OcrLanguage

export const OcrLanguageSchema = z.enum(OCR_LANGUAGES as [OcrLanguage, ...OcrLanguage[]])

export const OcrLanguagesSetSchema = z.object({ languages: z.array(OcrLanguageSchema) })
export type OcrLanguagesSetInput = z.infer<typeof OcrLanguagesSetSchema>

/**
 * Where one chosen language stands. `error` is display text or an `errors:`
 * i18n key, for `extractErrorMessage`.
 */
export type OcrLanguageStatus =
  | { state: 'ready' }
  | { state: 'downloading'; receivedBytes: number; totalBytes: number }
  | { state: 'failed'; error: string }

export interface OcrLanguagesState {
  /** The chosen languages, English first. */
  selected: OcrLanguage[]
  statuses: Partial<Record<OcrLanguage, OcrLanguageStatus>>
}
