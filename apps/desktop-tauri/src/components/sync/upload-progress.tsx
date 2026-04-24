import { memo } from 'react'
import { Upload, X, CheckCircle, AlertCircle } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface UploadProgressProps {
  fileName: string
  progress: number
  status: string
  className?: string
  onCancel?: () => void
}

const STATUS_LABELS: Record<string, string> = {
  hashing: 'Verifying...',
  encrypting: 'Encrypting...',
  uploading: 'Uploading...',
  completed: 'Upload complete',
  failed: 'Upload failed'
}

export const UploadProgress = memo(function UploadProgress({
  fileName,
  progress,
  status,
  className,
  onCancel
}: UploadProgressProps) {
  const isComplete = status === 'completed'
  const isFailed = status === 'failed'
  const isActive = !isComplete && !isFailed

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm',
        isComplete && 'border-green-500/30 bg-green-500/5',
        isFailed && 'border-red-500/30 bg-red-500/5',
        isActive && 'border-border bg-muted/30',
        className
      )}
      role="status"
      aria-label={`Upload ${fileName}: ${STATUS_LABELS[status] ?? status} ${progress}%`}
    >
      {isComplete ? (
        <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />
      ) : isFailed ? (
        <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
      ) : (
        <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}

      <div className="flex-1 min-w-0">
        <p className="truncate text-xs font-medium">{fileName}</p>
        <div className="mt-1 flex items-center gap-2">
          <div
            className="h-1 flex-1 rounded-full bg-muted overflow-hidden"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Upload progress: ${progress}%`}
          >
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                isComplete && 'bg-green-500',
                isFailed && 'bg-red-500',
                isActive && 'bg-primary'
              )}
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
          <span className="tabular-nums text-[10px] text-muted-foreground whitespace-nowrap">
            {progress}%
          </span>
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {STATUS_LABELS[status] ?? status}
        </p>
      </div>

      {isActive && onCancel && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          className="h-6 w-6 p-0 shrink-0"
          aria-label={`Cancel upload of ${fileName}`}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </Button>
      )}
    </div>
  )
})
