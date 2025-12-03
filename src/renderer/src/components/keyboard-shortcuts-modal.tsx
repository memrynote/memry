import { X } from "lucide-react"

import {
    AlertDialog,
    AlertDialogContent,
} from "@/components/ui/alert-dialog"
import { getKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { cn } from "@/lib/utils"

interface KeyboardShortcutsModalProps {
    isOpen: boolean
    onClose: () => void
}

const KeyboardShortcutsModal = ({
    isOpen,
    onClose,
}: KeyboardShortcutsModalProps): React.JSX.Element => {
    const shortcuts = getKeyboardShortcuts()

    const handleKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === "Escape") {
            e.preventDefault()
            onClose()
        }
    }

    const handleOpenChange = (open: boolean): void => {
        if (!open) {
            onClose()
        }
    }

    return (
        <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
            <AlertDialogContent
                className="max-w-3xl max-h-[85vh] overflow-hidden p-0"
                onKeyDown={handleKeyDown}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                    <h2 className="text-lg font-semibold text-foreground">
                        Keyboard Shortcuts
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className={cn(
                            "size-8 rounded-md flex items-center justify-center",
                            "text-muted-foreground hover:text-foreground hover:bg-muted",
                            "transition-colors duration-[var(--duration-instant)]",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        )}
                        aria-label="Close shortcuts help"
                    >
                        <X className="size-4" aria-hidden="true" />
                    </button>
                </div>

                {/* Content */}
                <div className="overflow-y-auto px-6 py-5 max-h-[calc(85vh-120px)]">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        {shortcuts.map((category) => (
                            <div key={category.title} className="space-y-3">
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                    {category.title}
                                </h3>
                                <div className="space-y-2">
                                    {category.shortcuts.map((shortcut) => (
                                        <div
                                            key={`${category.title}-${shortcut.key}`}
                                            className="flex items-center justify-between gap-4"
                                        >
                                            <span className="text-sm text-foreground">
                                                {shortcut.label}
                                            </span>
                                            <kbd
                                                className={cn(
                                                    "inline-flex items-center justify-center",
                                                    "min-w-[2rem] px-2 py-1 rounded-md",
                                                    "text-xs font-mono font-medium",
                                                    "bg-muted text-muted-foreground",
                                                    "border border-border"
                                                )}
                                            >
                                                {shortcut.key}
                                            </kbd>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-center px-6 py-4 border-t border-border bg-muted/30">
                    <p className="text-xs text-muted-foreground">
                        Press <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border font-mono text-xs">Esc</kbd> to close
                    </p>
                </div>
            </AlertDialogContent>
        </AlertDialog>
    )
}

export { KeyboardShortcutsModal }

