import { FileText, Link2, Copy, EyeOff } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

interface CardActionsMenuProps {
  children: React.ReactNode
  onOpenNote: () => void
  onAddReference: () => void
  onCopyLink: () => void
  onHide: () => void
}

export function CardActionsMenu({
  children,
  onOpenNote,
  onAddReference,
  onCopyLink,
  onHide
}: CardActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[180px] bg-white border-stone-200 shadow-lg"
      >
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation()
            onOpenNote()
          }}
          className="gap-2 cursor-pointer"
        >
          <FileText className="h-4 w-4 text-stone-500" />
          <span>Open note</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation()
            onAddReference()
          }}
          className="gap-2 cursor-pointer"
        >
          <Link2 className="h-4 w-4 text-stone-500" />
          <span>Add as reference</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation()
            onCopyLink()
          }}
          className="gap-2 cursor-pointer"
        >
          <Copy className="h-4 w-4 text-stone-500" />
          <span>Copy link</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation()
            onHide()
          }}
          className="gap-2 cursor-pointer"
        >
          <EyeOff className="h-4 w-4 text-stone-500" />
          <span>Hide from suggestions</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
