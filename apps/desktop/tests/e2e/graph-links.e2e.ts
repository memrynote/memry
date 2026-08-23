import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'

test.describe('Graph links E2E', () => {
  test('builds graph nodes and wikilink edges from notes', async ({ page }) => {
    await ready(page)

    const targetTitle = uniqueLabel('Graph Target')
    const sourceTitle = uniqueLabel('Graph Source')

    const seeded = await page.evaluate(
      async ({ sourceTitle, targetTitle }) => {
        const api = window.api
        const target = await api.notes.create({
          title: targetTitle,
          content: 'Target body for graph coverage.',
          tags: ['e2e-graph']
        })
        const source = await api.notes.create({
          title: sourceTitle,
          content: `This note links to [[${targetTitle}]].`,
          tags: ['e2e-graph']
        })

        if (!target.success || !target.note || !source.success || !source.note) {
          throw new Error('failed to seed graph notes')
        }

        return {
          sourceId: source.note.id,
          sourceTitle: source.note.title,
          targetId: target.note.id,
          targetTitle: target.note.title
        }
      },
      { sourceTitle, targetTitle }
    )

    await expect
      .poll(
        () =>
          page.evaluate(async ({ sourceId, targetId }) => {
            const graph = await window.api.graph.getData()
            return {
              labels: graph.nodes.map((node) => node.label),
              hasWikiEdge: graph.edges.some(
                (edge) =>
                  edge.type === 'wikilink' &&
                  ((edge.source === sourceId && edge.target === targetId) ||
                    (edge.source === targetId && edge.target === sourceId))
              )
            }
          }, seeded),
        { timeout: 20_000 }
      )
      .toMatchObject({
        labels: expect.arrayContaining([seeded.sourceTitle, seeded.targetTitle]),
        hasWikiEdge: true
      })
  })

  test('preserves backlinks after renaming a wikilink target note', async ({ page }) => {
    await ready(page)

    const targetTitle = uniqueLabel('Backlink Target')
    const renamedTitle = uniqueLabel('Backlink Renamed')
    const sourceTitle = uniqueLabel('Backlink Source')

    const seeded = await page.evaluate(
      async ({ sourceTitle, targetTitle }) => {
        const target = await window.api.notes.create({
          title: targetTitle,
          content: 'Target body for backlink rename coverage.'
        })
        const source = await window.api.notes.create({
          title: sourceTitle,
          content: `This source keeps a wikilink to [[${targetTitle}]].`
        })

        if (!target.success || !target.note || !source.success || !source.note) {
          throw new Error('failed to seed backlink notes')
        }

        return {
          sourceId: source.note.id,
          targetId: target.note.id,
          oldWikilink: `[[${targetTitle}]]`
        }
      },
      { sourceTitle, targetTitle }
    )

    await expect
      .poll(
        () =>
          page.evaluate(async ({ sourceId, targetId }) => {
            const [sourceLinks, targetLinks] = await Promise.all([
              window.api.notes.getLinks(sourceId),
              window.api.notes.getLinks(targetId)
            ])
            return {
              outgoingTargetIds: sourceLinks.outgoing.map((link) => link.targetId),
              incomingSourceIds: targetLinks.incoming.map((link) => link.sourceId)
            }
          }, seeded),
        { timeout: 20_000 }
      )
      .toMatchObject({
        outgoingTargetIds: expect.arrayContaining([seeded.targetId]),
        incomingSourceIds: expect.arrayContaining([seeded.sourceId])
      })

    const renameResult = await page.evaluate(
      ({ targetId, renamedTitle }) => window.api.notes.rename(targetId, renamedTitle),
      { targetId: seeded.targetId, renamedTitle }
    )
    expect(renameResult.success).toBe(true)

    // The rename rewrites the source's `[[Old]]` to `[[New]]` vault-wide
    // (#1711), so the backlink survives on the CONTENT level, not just as a
    // lingering `target_id` in the index.
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ sourceId, targetId, renamedTitle }) => {
              const [source, target, sourceLinks, targetLinks] = await Promise.all([
                window.api.notes.get(sourceId),
                window.api.notes.get(targetId),
                window.api.notes.getLinks(sourceId),
                window.api.notes.getLinks(targetId)
              ])
              return {
                targetTitle: target?.title ?? null,
                sourceContent: source?.content ?? '',
                outgoingTargetIds: sourceLinks.outgoing.map((link) => link.targetId),
                incomingSourceIds: targetLinks.incoming.map((link) => link.sourceId),
                outgoingTargetTitles: sourceLinks.outgoing.map((link) => link.targetTitle),
                renamedTitle
              }
            },
            { ...seeded, renamedTitle }
          ),
        { timeout: 20_000 }
      )
      .toMatchObject({
        targetTitle: renamedTitle,
        sourceContent: expect.stringContaining(`[[${renamedTitle}]]`),
        outgoingTargetIds: expect.arrayContaining([seeded.targetId]),
        incomingSourceIds: expect.arrayContaining([seeded.sourceId]),
        outgoingTargetTitles: expect.arrayContaining([renamedTitle])
      })

    const sourceAfterRename = await page.evaluate(
      ({ sourceId }) => window.api.notes.get(sourceId).then((note) => note?.content ?? ''),
      seeded
    )
    expect(sourceAfterRename).not.toContain(seeded.oldWikilink)
  })
})
