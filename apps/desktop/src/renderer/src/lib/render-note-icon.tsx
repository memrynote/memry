import { isIconValue, parseIconName } from '@/components/note/note-title/emoji-icon-utils'
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
  return <span className={className}>{value}</span>
}
