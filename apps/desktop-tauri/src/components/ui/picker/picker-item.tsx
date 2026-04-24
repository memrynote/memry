import * as React from 'react'
import { CheckMark } from '@/components/ui/check-mark'
import { FilterCheckbox } from '@/components/ui/filter-checkbox'
import { cn } from '@/lib/utils'
import { usePickerContext, type PickerIndicator } from './types'

export interface PickerItemProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'value'
> {
  value: string
  label: string
  icon?: React.ReactNode
  description?: string
  shortcut?: string
  trailing?: React.ReactNode
  indicator?: PickerIndicator
  indicatorColor?: string
  destructive?: boolean
}

export const PickerItem = React.forwardRef<HTMLButtonElement, PickerItemProps>(
  (
    {
      value,
      label,
      icon,
      description,
      shortcut,
      trailing,
      indicator = 'none',
      indicatorColor,
      destructive = false,
      className,
      style,
      onClick,
      ...props
    },
    ref
  ) => {
    const { value: contextValue, onValueChange } = usePickerContext()

    const isSelected = Array.isArray(contextValue)
      ? contextValue.includes(value)
      : contextValue === value

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e)
      if (!e.defaultPrevented) onValueChange(value)
    }

    const selectedBg =
      isSelected && indicatorColor ? { backgroundColor: `${indicatorColor}0F` } : undefined
    const mergedStyle = selectedBg ? { ...selectedBg, ...style } : style

    return (
      <button
        ref={ref}
        type="button"
        role="option"
        aria-selected={isSelected}
        data-slot="picker-item"
        className={cn(
          'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
          'hover:bg-accent focus:outline-none',
          isSelected && !indicatorColor && 'bg-accent',
          destructive && 'text-destructive focus:text-destructive',
          className
        )}
        style={mergedStyle}
        onClick={handleClick}
        {...props}
      >
        {indicator === 'checkbox' && <FilterCheckbox checked={isSelected} color={indicatorColor} />}

        {indicator === 'dot' && indicatorColor && (
          <span
            className="size-2.5 rounded-full shrink-0"
            style={{ backgroundColor: indicatorColor }}
          />
        )}

        {icon && <span className="shrink-0 flex items-center">{icon}</span>}

        <span className="flex flex-col items-start min-w-0 flex-1">
          <span
            className={cn('text-muted-foreground', destructive && 'text-destructive')}
            style={isSelected && indicatorColor ? { color: indicatorColor } : undefined}
          >
            {label}
          </span>
          {description && (
            <span className="truncate text-[11px] text-muted-foreground/70 leading-4">
              {description}
            </span>
          )}
        </span>

        {trailing && <span className="shrink-0 ml-auto">{trailing}</span>}

        {shortcut && (
          <kbd className="ml-auto shrink-0 text-[11px] text-muted-foreground/50 font-mono">
            {shortcut}
          </kbd>
        )}

        {indicator === 'check' && isSelected && (
          <CheckMark color={indicatorColor} className="ml-auto" />
        )}
      </button>
    )
  }
)
PickerItem.displayName = 'PickerItem'
