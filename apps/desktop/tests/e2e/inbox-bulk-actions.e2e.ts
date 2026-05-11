import { test, expect } from './fixtures'
import { PNG_BYTES, ready } from './utils/desktop-test-helpers'

test.describe('Inbox bulk actions E2E', () => {
  test('captures image and text items, bulk tags, archives, and restores inbox entries', async ({
    page
  }) => {
    await ready(page)

    const result = await page.evaluate(async (pngBytes) => {
      const api = window.api
      const image = await api.inbox.captureImage({
        data: new Uint8Array(pngBytes),
        filename: 'inbox-image.png',
        mimeType: 'image/png',
        tags: ['e2e-inbox'],
        source: 'api'
      })
      if (!image.success || !image.item) throw new Error(image.error ?? 'image capture failed')

      const first = await api.inbox.captureText({
        title: 'E2E Inbox Bulk One',
        content: 'First bulk inbox item',
        tags: ['e2e-inbox'],
        force: true,
        source: 'api'
      })
      const second = await api.inbox.captureText({
        title: 'E2E Inbox Bulk Two',
        content: 'Second bulk inbox item',
        tags: ['e2e-inbox'],
        force: true,
        source: 'api'
      })
      if (!first.success || !first.item || !second.success || !second.item) {
        throw new Error('text inbox capture failed')
      }

      const bulkTag = await api.inbox.bulkTag({
        itemIds: [first.item.id, second.item.id],
        tags: ['bulk-e2e']
      })
      const bulkArchive = await api.inbox.bulkArchive({
        itemIds: [first.item.id, second.item.id, image.item.id]
      })
      const archived = await api.inbox.listArchived({ search: 'E2E Inbox', limit: 10 })
      await api.inbox.unarchive(first.item.id)
      const restored = await api.inbox.get(first.item.id)

      return {
        imageItemId: image.item.id,
        imageAttachmentPath: image.item.attachmentPath,
        firstItemId: first.item.id,
        bulkTag,
        bulkArchive,
        archivedIds: archived.items.map((item) => item.id),
        restoredArchivedAt: restored?.archivedAt ?? null
      }
    }, PNG_BYTES)

    expect(result.imageItemId).toBeTruthy()
    expect(result.imageAttachmentPath).toContain('attachments')
    expect(result.bulkTag).toMatchObject({ success: true, processedCount: 2, errors: [] })
    expect(result.bulkArchive).toMatchObject({ success: true, processedCount: 3, errors: [] })
    expect(result.archivedIds).toEqual(expect.arrayContaining([result.firstItemId]))
    expect(result.restoredArchivedAt).toBeNull()
  })
})
