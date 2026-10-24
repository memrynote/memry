import appleJournalIcon from '@/assets/import-sources/apple-journal.png'
import appleNotesIcon from '@/assets/import-sources/apple-notes.png'
import bearIcon from '@/assets/import-sources/bear.png'
import evernoteIcon from '@/assets/import-sources/evernote.svg'
import googleKeepIcon from '@/assets/import-sources/google-keep.svg'
import noteplanIcon from '@/assets/import-sources/noteplan.png'
import notionIcon from '@/assets/import-sources/notion.png'
import obsidianIcon from '@/assets/import-sources/obsidian.svg'
import onenoteIcon from '@/assets/import-sources/onenote.png'
import raindropIcon from '@/assets/import-sources/raindrop.png'
import roamIcon from '@/assets/import-sources/roam.png'
import ticktickIcon from '@/assets/import-sources/ticktick.png'
import todoistIcon from '@/assets/import-sources/todoist.png'
import { FileCode, FileSpreadsheet, FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'

/** Brand logos keyed by importer id, plus `obsidian` for detected Obsidian vaults. */
const SOURCE_LOGOS: Record<string, string> = {
  notion: notionIcon,
  evernote: evernoteIcon,
  'apple-notes': appleNotesIcon,
  bear: bearIcon,
  onenote: onenoteIcon,
  'google-keep': googleKeepIcon,
  roam: roamIcon,
  noteplan: noteplanIcon,
  todoist: todoistIcon,
  ticktick: ticktickIcon,
  'apple-journal': appleJournalIcon,
  raindrop: raindropIcon,
  obsidian: obsidianIcon
}

const FORMAT_ICONS: Record<string, typeof FileText> = {
  markdown: FileText,
  html: FileCode,
  csv: FileSpreadsheet
}

export function hasSourceLogo(id: string): boolean {
  return id in SOURCE_LOGOS
}

/** An import source's logo, or a format glyph / initial when it has none. */
export function ImportSourceIcon({
  id,
  name,
  className
}: {
  id: string
  name: string
  className?: string
}): React.JSX.Element {
  const logo = SOURCE_LOGOS[id]
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn('size-6 shrink-0 rounded-md object-contain', className)}
      />
    )
  }
  const FormatIcon = FORMAT_ICONS[id]
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md border border-border text-[11px]/4 font-medium text-muted-foreground',
        className
      )}
    >
      {FormatIcon ? <FormatIcon className="size-3.5" /> : name.charAt(0).toUpperCase()}
    </span>
  )
}
