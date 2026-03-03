import { FileText, Folder } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SearchResultItemProps {
  id: string
  title: string
  path: string
  snippet: string
  tags: string[]
  isSelected: boolean
  onClick: () => void
}

export function SearchResultItem({
  title,
  path,
  snippet,
  tags,
  isSelected,
  onClick
}: SearchResultItemProps) {
  // Extract folder from path (e.g., "notes/folder/file.md" -> "folder")
  const folder = path.split('/').slice(0, -1).pop() || ''

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-md transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
      )}
      role="option"
      aria-selected={isSelected}
    >
      {/* Title row */}
      <div className="flex items-center gap-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span
          className="font-medium truncate [&_mark]:bg-yellow-200/60 [&_mark]:dark:bg-yellow-500/40 [&_mark]:rounded-sm [&_mark]:px-0.5"
          dangerouslySetInnerHTML={{ __html: title }}
        />
      </div>

      {/* Path/folder */}
      {folder && (
        <div className="flex items-center gap-1.5 mt-1 ml-6 text-xs text-muted-foreground">
          <Folder className="size-3" />
          <span className="truncate">{folder}</span>
        </div>
      )}

      {/* Snippet with highlighting */}
      {snippet && (
        <p
          className="mt-1.5 ml-6 text-sm text-muted-foreground line-clamp-2 [&_mark]:bg-yellow-200/60 [&_mark]:dark:bg-yellow-500/40 [&_mark]:rounded-sm [&_mark]:px-0.5"
          dangerouslySetInnerHTML={{ __html: snippet }}
        />
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2 ml-6">
          {tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-muted text-muted-foreground"
            >
              #{tag}
            </span>
          ))}
          {tags.length > 3 && (
            <span className="text-xs text-muted-foreground">+{tags.length - 3}</span>
          )}
        </div>
      )}
    </button>
  )
}
