import type { ReactNode } from 'react'
import { ArrowLeft } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

/**
 * Shared frame for the onboarding sub-flows (create vault, open from sync):
 * a back link, a title block, the step body, and an optional footer row.
 */
export function OnboardingStep({
  onBack,
  title,
  subtitle,
  children,
  footer
}: {
  onBack: () => void
  title?: string
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}): React.JSX.Element {
  const { t } = useT('common')
  return (
    <div className="flex flex-col grow shrink basis-0 min-h-0">
      <div className="flex flex-col grow shrink basis-0 min-h-0 overflow-y-auto">
        <div className="flex flex-col w-full max-w-[440px] self-center pt-6 pb-8 px-8 gap-6">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center self-start gap-1.5 -ms-1 rounded-md px-1 py-0.5 text-xs leading-4 text-text-tertiary hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3.5 rtl:rotate-180" />
            <span>{t('phaseF.componentsVaultOnboarding.flow.back')}</span>
          </button>
          {title && (
            <div className="flex flex-col gap-1.5">
              <h2 className="font-heading font-semibold text-text-bright text-xl leading-6 tracking-[-0.01em]">
                {title}
              </h2>
              {subtitle && (
                <p className="text-[13px] leading-[19px] text-text-tertiary">{subtitle}</p>
              )}
            </div>
          )}
          {children}
        </div>
      </div>
      {footer && (
        <div className="flex items-center justify-end gap-2 shrink-0 border-t border-border px-8 py-3">
          {footer}
        </div>
      )}
    </div>
  )
}
