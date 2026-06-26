import { isIconValue, parseIconName } from '@/components/note/note-title/emoji-icon-utils'
import { cn } from '@/lib/utils'
import { HugeIconByName } from './hugeicon-renderer'

export function NoteIconDisplay({
  value,
  className
}: {
  value: string
  className?: string
}): React.JSX.Element {
  if (isIconValue(value)) {
    return <HugeIconByName name={parseIconName(value)} className={className} />
  }
  return (
    <span className={cn('inline-flex items-center justify-center leading-none', className)}>
      {value}
    </span>
  )
}
