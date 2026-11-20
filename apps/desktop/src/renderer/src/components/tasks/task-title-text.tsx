/**
 * A task title as text, with its `[[…]]` runs drawn as note links (#5294).
 *
 * The title is a plain string, and a task typed in a note keeps its links in
 * it as `[[Note]]`. Every surface that shows the title reads it through here,
 * so a link opens its note from the note's task row, the Tasks list and the
 * task drawer alike.
 */

import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { wikiLinkLabel } from '@memry/shared/wiki-target'
import { findNoteLinks } from '@/lib/quick-add-parser'
import { useOpenWikiTarget } from '@/hooks/use-open-wiki-target'

export function TaskTitleText({ title }: { title: string }): ReactNode {
  const links = findNoteLinks(title)
  if (links.length === 0) return title

  const parts: ReactNode[] = []
  let cursor = 0
  for (const link of links) {
    if (link.start > cursor) {
      parts.push(<Fragment key={cursor}>{title.slice(cursor, link.start)}</Fragment>)
    }
    const [target, alias] = link.title.split('|', 2)
    parts.push(<TitleLink key={link.start} target={target.trim()} alias={alias} />)
    cursor = link.end
  }
  if (cursor < title.length) parts.push(<Fragment key={cursor}>{title.slice(cursor)}</Fragment>)
  return parts
}

function TitleLink({ target, alias }: { target: string; alias?: string }): ReactNode {
  const openWikiTarget = useOpenWikiTarget()
  const open = (e: MouseEvent | KeyboardEvent): void => {
    // The row, the title button and the editor under them all act on a click;
    // this one belongs to the link.
    e.preventDefault()
    e.stopPropagation()
    openWikiTarget(target)
  }
  return (
    <span
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the link sits inside the title's own <button>, where an <a> or <button> would be invalid nesting
      role="link"
      tabIndex={0}
      data-task-title-link=""
      className="wiki-link"
      onClick={open}
      onKeyDown={(e) => {
        // Space too: left to bubble, it would activate the title button around
        // the link and start editing the title instead.
        if (e.key === 'Enter' || e.key === ' ') open(e)
      }}
    >
      {wikiLinkLabel(target, alias)}
    </span>
  )
}
