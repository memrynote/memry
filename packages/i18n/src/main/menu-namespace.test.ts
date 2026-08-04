import { describe, expect, it } from 'vitest'
import { createMainI18n } from './index'

describe('menu namespace', () => {
  it('returns every current English app-menu label', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    expect(i18n.t('menu:file.label')).toBe('File')
    expect(i18n.t('menu:file.newNote')).toBe('New Note')
    expect(i18n.t('menu:file.close')).toBe('Close Window')
    expect(i18n.t('menu:edit.undo')).toBe('Undo')
    expect(i18n.t('menu:edit.redo')).toBe('Redo')
    expect(i18n.t('menu:edit.cut')).toBe('Cut')
    expect(i18n.t('menu:edit.copy')).toBe('Copy')
    expect(i18n.t('menu:edit.paste')).toBe('Paste')
    expect(i18n.t('menu:edit.selectAll')).toBe('Select All')
    expect(i18n.t('menu:view.reload')).toBe('Reload')
    expect(i18n.t('menu:view.toggleDevTools')).toBe('Toggle Developer Tools')
    expect(i18n.t('menu:view.toggleFullscreen')).toBe('Toggle Full Screen')
  })

  it('translates current Turkish app-menu labels', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })

    expect(i18n.t('menu:file.label')).toBe('Dosya')
    expect(i18n.t('menu:file.newNote')).toBe('Yeni Not')
    // Turkish menu items are title case, like the siblings above.
    expect(i18n.t('menu:view.reload')).toBe('Yeniden Yükle')
  })

  it('translates current Arabic app-menu labels', async () => {
    const i18n = await createMainI18n({ locale: 'ar' })

    expect(i18n.t('menu:file.label')).toBe('ملف')
    expect(i18n.t('menu:view.reload')).toBe('إعادة تحميل')
  })

  it('keeps the namespace on missing menu keys', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    expect(i18n.t('menu:missing.key')).toBe('menu:missing.key')
  })
})
