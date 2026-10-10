import { inboxSpecs } from '../content/inbox.ts'
import { assetPath, need, type SandboxStep } from '../context.ts'

export const createInbox: SandboxStep = async (ctx) => {
  const { app, clock } = ctx
  for (const spec of inboxSpecs) {
    const item =
      spec.kind === 'link'
        ? await app.inbox.captureLink({ url: spec.url!, tags: spec.tags })
        : spec.kind === 'file'
          ? await app.inbox.captureFile({
              filePath: assetPath(spec.asset!),
              title: spec.title,
              tags: spec.tags
            })
          : await app.inbox.captureText({
              title: spec.title,
              content: spec.content!,
              tags: spec.tags
            })
    ctx.inbox.set(spec.key, item.id)
    // captureLink titles a link from its URL slug and never fetches the page.
    if (spec.kind === 'link' && spec.title) await app.inbox.update(item.id, { title: spec.title })

    if (spec.viewed) await app.inbox.markViewed(item.id)
    if (spec.snooze) await app.inbox.snooze(item.id, clock.at(spec.snooze, '09:00'), 'Not now')
    if (spec.archived) await app.inbox.archive(item.id)

    const filed = spec.filed
    if (!filed) continue
    if (filed.action === 'task') {
      await app.inbox.convertToTask(item.id)
      continue
    }
    // The CLI writes both kinds of filed capture as a new note at the vault root.
    const result =
      filed.action === 'note'
        ? await app.inbox.convertToNote(item.id)
        : await app.inbox.linkToNote(item.id, need(ctx.notes, filed.note, 'note').id, spec.tags)
    if (!result.success) throw new Error(`Filing ${spec.key} failed: ${result.error}`)
  }
}
