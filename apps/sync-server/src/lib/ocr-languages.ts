// Tesseract codes for the languages packages/i18n ships UI translations for.
// scripts/upload-ocr-language-data.ts imports this file with Node's type
// stripping, so it stays plain erasable TypeScript with no imports.
export const OCR_LANGUAGES = [
  'ara',
  'ces',
  'chi_sim',
  'chi_tra',
  'dan',
  'deu',
  'ell',
  'eng',
  'fil',
  'fin',
  'fra',
  'heb',
  'hrv',
  'hun',
  'ind',
  'ita',
  'jpn',
  'kor',
  'msa',
  'nld',
  'nor',
  'pol',
  'por',
  'ron',
  'rus',
  'slk',
  'spa',
  'swe',
  'tha',
  'tur',
  'ukr',
  'vie'
] as const

export type OcrLanguage = (typeof OCR_LANGUAGES)[number]

export const isOcrLanguage = (value: string): value is OcrLanguage =>
  (OCR_LANGUAGES as readonly string[]).includes(value)

export const ocrLanguageKey = (lang: OcrLanguage): string => `ocr/v1/${lang}.traineddata.gz`

export const OCR_MANIFEST_KEY = 'ocr/v1/manifest.json'
