import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { WritingCheckKind, WritingTrimLevel } from '@memry/contracts/writing-tools-api'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import type { WritingToolsSession, WritingToolsSnapshot } from './writing-tools-session'

interface LabRailProps {
  session: WritingToolsSession
  snapshot: WritingToolsSnapshot
}

const TRIM_LEVELS: WritingTrimLevel[] = ['slight', 'tighten', 'sharper', 'half']

/** AI writing checks and trim suggestions. Only mounted while AI is enabled. */
export function LabRail({ session, snapshot }: LabRailProps) {
  const { t } = useT('notes')
  const { running, flags, focusedFlagId, trim } = snapshot.lab
  const busy = running !== null

  const checkLabels: Record<WritingCheckKind, string> = {
    convoluted: t('writingTools.lab.convoluted'),
    tone: t('writingTools.lab.tone')
  }
  const trimLabels: Record<WritingTrimLevel, string> = {
    slight: t('writingTools.lab.slight'),
    tighten: t('writingTools.lab.tighten'),
    sharper: t('writingTools.lab.sharper'),
    half: t('writingTools.lab.half')
  }

  const runCheck = async (check: WritingCheckKind): Promise<void> => {
    try {
      const count = await session.runCheck(check)
      if (count === null) toast(t('writingTools.lab.emptyNote'))
      else if (count === 0) toast(t('writingTools.lab.noResults'))
    } catch (error) {
      toast.error(extractErrorMessage(error, t('writingTools.lab.checkFailed')))
    }
  }

  const runTrim = async (level: WritingTrimLevel): Promise<void> => {
    try {
      const count = await session.runTrim(level)
      if (count === null) toast(t('writingTools.lab.emptyNote'))
      else if (count === 0) toast(t('writingTools.lab.noCuts'))
    } catch (error) {
      toast.error(extractErrorMessage(error, t('writingTools.lab.trimFailed')))
    }
  }

  return (
    <aside aria-label={t('writingTools.lab.railAria')} data-marquee-ignore className="review-rail">
      <div className="review-rail-inner writing-rail-panel flex flex-col gap-4">
        <section className="flex flex-col gap-1">
          <h3 className="writing-rail-heading">{t('writingTools.lab.check')}</h3>
          {(['convoluted', 'tone'] as const).map((check) => (
            <div key={check} className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-sm">{checkLabels[check]}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs"
                disabled={busy}
                aria-busy={running === check}
                onClick={() => void runCheck(check)}
              >
                {running === check ? (
                  <Spinner
                    className="size-3.5 motion-reduce:animate-none"
                    aria-label={t('writingTools.lab.running')}
                  />
                ) : (
                  t('writingTools.lab.run')
                )}
              </Button>
            </div>
          ))}
        </section>

        {flags.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="writing-rail-heading">{t('writingTools.lab.results')}</h3>
            <ul className="flex flex-col gap-1">
              {flags.map((flag) => (
                <li key={flag.id}>
                  <button
                    type="button"
                    aria-pressed={focusedFlagId === flag.id}
                    className={cn(
                      'w-full rounded-md px-2 py-1.5 text-start transition-colors motion-reduce:transition-none',
                      focusedFlagId === flag.id ? 'bg-tint-lighter' : 'hover:bg-surface-active'
                    )}
                    onClick={() => session.focusFlag(flag.id)}
                  >
                    <span className="line-clamp-2 text-sm">{flag.quote}</span>
                    <span className="mt-0.5 block text-xs text-text-tertiary">{flag.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <h3 className="writing-rail-heading">{t('writingTools.lab.trim')}</h3>
            {(trim || (running !== null && TRIM_LEVELS.includes(running as WritingTrimLevel))) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => session.stopTrim()}
              >
                {t('writingTools.lab.stop')}
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {TRIM_LEVELS.map((level) => (
              <Button
                key={level}
                type="button"
                variant="outline"
                size="sm"
                className="h-8 justify-center text-xs"
                disabled={busy}
                aria-pressed={trim?.level === level}
                aria-busy={running === level}
                onClick={() => void runTrim(level)}
              >
                {running === level ? (
                  <Spinner
                    className="size-3.5 motion-reduce:animate-none"
                    aria-label={t('writingTools.lab.running')}
                  />
                ) : (
                  trimLabels[level]
                )}
              </Button>
            ))}
          </div>
        </section>
      </div>
    </aside>
  )
}
