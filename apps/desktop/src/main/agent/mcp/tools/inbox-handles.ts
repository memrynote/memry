import { createDesktopInboxCrudHandlers, createDesktopInboxDomain } from '../../../inbox/domain'
import { assertSuccess } from './assert-success'
import type { InboxSummary, VaultServiceHandles } from './handles'

function inboxVisualType(item: {
  type?: string
  sourceUrl?: string | null
  metadata?: unknown
}): string | undefined {
  if (item.type === 'clip') return 'quote'

  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : null
  const platform =
    metadata && 'platform' in metadata && typeof metadata.platform === 'string'
      ? metadata.platform
      : null

  if (item.type === 'social' && platform === 'twitter') return 'twitter'
  if ((item.type === 'social' || item.type === 'link') && item.sourceUrl) {
    try {
      const host = new URL(item.sourceUrl).hostname.toLowerCase()
      if (
        host === 'x.com' ||
        host.endsWith('.x.com') ||
        host === 'twitter.com' ||
        host.endsWith('.twitter.com')
      ) {
        return 'twitter'
      }
    } catch {
      return item.type === 'social' ? 'social' : undefined
    }
  }

  return item.type === 'social' ? 'social' : undefined
}

export function createInboxHandles(): VaultServiceHandles['inbox'] {
  return {
    async list({ unread_only }) {
      const result = await createDesktopInboxDomain().list({
        limit: 100,
        offset: 0,
        sortBy: 'created',
        sortOrder: 'desc'
      })
      return result.items
        .filter((item) => !unread_only || !item.viewedAt)
        .map<InboxSummary>((item) => {
          const visualType = inboxVisualType(item)
          return {
            id: item.id,
            type: item.type,
            ...(visualType ? { visual_type: visualType } : {}),
            source: item.sourceUrl ?? item.captureSource ?? item.type,
            title: item.title,
            snippet: item.content ?? item.transcription ?? item.excerpt ?? '',
            captured_at: item.createdAt.getTime()
          }
        })
    },
    async get(id) {
      return createDesktopInboxCrudHandlers().handleGet(id)
    },
    async add({ source, title, content }) {
      const result = await createDesktopInboxDomain().captureText({
        title,
        content,
        source: source === 'api' ? 'api' : 'inline',
        force: true
      })
      if (!result.success || !result.item) {
        throw new Error(result.error ?? 'Failed to add inbox item')
      }
      return { id: result.item.id }
    },
    async update(input) {
      const result = await createDesktopInboxCrudHandlers().handleUpdate(input)
      assertSuccess(result, 'Failed to update inbox item')
      return { id: input.id }
    },
    async snooze({ id, snooze_until, reason }) {
      const result = await createDesktopInboxDomain().snooze({
        itemId: id,
        snoozeUntil: snooze_until,
        reason
      })
      assertSuccess(result, 'Failed to snooze inbox item')
      return { id }
    },
    async archive(id) {
      const result = await createDesktopInboxCrudHandlers().handleArchive(id)
      assertSuccess(result, 'Failed to archive inbox item')
      return { id }
    },
    async unarchive(id) {
      const result = await createDesktopInboxCrudHandlers().handleUnarchive(id)
      assertSuccess(result, 'Failed to unarchive inbox item')
      return { id }
    },
    async delete(id) {
      const result = await createDesktopInboxCrudHandlers().handleDeletePermanent(id)
      assertSuccess(result, 'Failed to delete inbox item')
      return { id }
    },
    async addTag({ id, tag }) {
      const result = await createDesktopInboxCrudHandlers().handleAddTag(id, tag)
      assertSuccess(result, 'Failed to add inbox tag')
      return { id }
    },
    async removeTag({ id, tag }) {
      const result = await createDesktopInboxCrudHandlers().handleRemoveTag(id, tag)
      assertSuccess(result, 'Failed to remove inbox tag')
      return { id }
    }
  }
}
