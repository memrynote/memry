import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

test.describe('Settings persistence E2E', () => {
  test('persists settings groups through renderer-to-main IPC', async ({ page }) => {
    await ready(page)

    const settings = await page.evaluate(async () => {
      const api = window.api

      const writes = await Promise.all([
        api.settings.setGeneralSettings({
          theme: 'dark',
          fontSize: 'large',
          fontFamily: 'geist',
          accentColor: '#0f766e',
          createInSelectedFolder: true,
          clockFormat: '24h'
        }),
        api.settings.setEditorSettings({
          width: 'wide',
          spellCheck: false,
          autoSaveDelay: 750,
          showWordCount: true,
          toolbarMode: 'sticky'
        }),
        api.settings.setTaskSettings({
          defaultSortOrder: 'priority',
          weekStartDay: 'monday',
          staleInboxDays: 9
        }),
        api.settings.setTabSettings({
          previewMode: false,
          restoreSessionOnStart: true,
          tabCloseButton: 'always'
        }),
        api.settings.setGraphSettings({
          layout: 'circular',
          nodeSizing: 'by-connections',
          showLabels: false,
          linkDistance: 180,
          repulsionStrength: 900,
          showEdgeLabels: true,
          animateLayout: false,
          showTagEdges: false
        }),
        api.settings.setJournalSettings({
          showSchedule: false,
          showTasks: true,
          showAIConnections: true,
          showStatsFooter: true
        }),
        api.settings.setSyncSettings({ enabled: true, autoSync: false }),
        api.settings.setBackupSettings({ autoBackup: true, frequencyHours: 12, maxBackups: 5 }),
        api.settings.setAISettings({ enabled: true }),
        api.settings.setVoiceTranscriptionSettings({ provider: 'openai' })
      ])

      const failed = writes.find((write) => !write.success)
      if (failed) throw new Error(failed.error ?? 'settings write failed')

      return {
        general: await api.settings.getGeneralSettings(),
        editor: await api.settings.getEditorSettings(),
        tasks: await api.settings.getTaskSettings(),
        tabs: await api.settings.getTabSettings(),
        graph: await api.settings.getGraphSettings(),
        journal: await api.settings.getJournalSettings(),
        sync: await api.settings.getSyncSettings(),
        backup: await api.settings.getBackupSettings(),
        ai: await api.settings.getAISettings(),
        voice: await api.settings.getVoiceTranscriptionSettings(),
        voiceReadiness: await api.settings.getVoiceRecordingReadiness()
      }
    })

    expect(settings.general).toMatchObject({
      theme: 'dark',
      fontSize: 'large',
      fontFamily: 'geist',
      accentColor: '#0f766e',
      createInSelectedFolder: true,
      clockFormat: '24h'
    })
    expect(settings.editor).toMatchObject({
      width: 'wide',
      spellCheck: false,
      autoSaveDelay: 750,
      showWordCount: true,
      toolbarMode: 'sticky'
    })
    expect(settings.tasks).toMatchObject({
      defaultSortOrder: 'priority',
      weekStartDay: 'monday',
      staleInboxDays: 9
    })
    expect(settings.tabs).toMatchObject({
      previewMode: false,
      restoreSessionOnStart: true,
      tabCloseButton: 'always'
    })
    expect(settings.graph).toMatchObject({
      layout: 'circular',
      nodeSizing: 'by-connections',
      showLabels: false,
      linkDistance: 180,
      repulsionStrength: 900,
      showEdgeLabels: true,
      animateLayout: false,
      showTagEdges: false
    })
    expect(settings.journal).toMatchObject({
      showSchedule: false,
      showTasks: true,
      showAIConnections: true,
      showStatsFooter: true
    })
    expect(settings.sync).toMatchObject({ enabled: true, autoSync: false })
    expect(settings.backup).toMatchObject({ autoBackup: true, frequencyHours: 12, maxBackups: 5 })
    expect(settings.ai).toMatchObject({ enabled: true })
    expect(settings.voice).toMatchObject({ provider: 'openai' })
    expect(settings.voiceReadiness.provider).toBe('openai')
  })
})
