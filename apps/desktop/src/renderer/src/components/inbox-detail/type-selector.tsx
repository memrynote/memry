/**
 * Type selector — inbox detail panel.
 *
 * Segmented control choosing what the captured item becomes:
 * Note (file to a folder) · Task · Event · Reminder. Replaces the old bottom
 * "Convert" row; the selection drives the panel body and primary action.
 * Note-only items (image/pdf/video/clip) have nothing to choose, so the panel
 * hides this control for them rather than rendering a one-option group.
 */

import { useId } from 'react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'
import type { ConvertType } from './convert-types'

interface TypeSelectorProps {
  value: ConvertType
  onChange: (type: ConvertType) => void
}

const OPTIONS: ConvertType[] = ['note', 'task', 'event', 'reminder']

export const TypeSelector = ({ value, onChange }: TypeSelectorProps): React.JSX.Element => {
  const { t } = useT('inbox')
  const prefersReducedMotion = useReducedMotion()
  const layoutGroupId = useId()

  return (
    <LayoutGroup id={layoutGroupId}>
      {/* A quiet label + compact segmented control, not a full-width bordered
          grid: it picks the form below, it is not the form. */}
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="text-[12px] leading-4 text-text-tertiary">
          {t('convert.chooseType')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('convert.chooseType')}
          className="flex gap-0.5 p-0.5 rounded-[7px] bg-surface-active/70"
        >
          {OPTIONS.map((type) => {
            const selected = value === type
            return (
              <span key={type} className="flex">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange(type)}
                  className={cn(
                    'relative flex h-6 items-center rounded-[5px] px-2.5 text-[12px] leading-4',
                    'transition-colors duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                    selected
                      ? 'text-text-primary font-medium'
                      : 'text-text-secondary hover:text-text-primary'
                  )}
                >
                  {selected && (
                    <motion.span
                      layoutId="type-selector-pill"
                      aria-hidden="true"
                      transition={
                        prefersReducedMotion
                          ? { duration: 0 }
                          : { type: 'spring', bounce: 0, duration: 0.3 }
                      }
                      className="absolute inset-0 rounded-[5px] bg-background shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                    />
                  )}
                  <span className="relative z-10">{t(`convert.${type}`)}</span>
                </button>
              </span>
            )
          })}
        </div>
      </div>
    </LayoutGroup>
  )
}
