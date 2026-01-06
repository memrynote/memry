/**
 * Summary Row Component
 *
 * Renders a sticky footer row in the folder table view that displays
 * aggregated values (sum, average, count, etc.) for each configured column.
 *
 * @module components/folder-view/summary-row
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  getColumnValues,
  computeSummary,
  formatSummaryValue,
  getSummaryTypeSymbol
} from '@/lib/summary-evaluator'
import type {
  ColumnConfig,
  NoteWithProperties,
  SummaryConfig
} from '@shared/contracts/folder-view-api'

// ============================================================================
// Types
// ============================================================================

interface SummaryRowProps {
  /** Visible columns configuration */
  columns: ColumnConfig[]
  /** Notes to compute summaries from (should be filtered notes) */
  notes: NoteWithProperties[]
  /** Summary configuration per column (keyed by column id) */
  summaries: Record<string, SummaryConfig>
  /** Formulas for formula column evaluation */
  formulas?: Record<string, string>
  /** Display density */
  density: 'compact' | 'comfortable'
  /** Whether to show column borders */
  showColumnBorders: boolean
  /** Column widths (from table state) */
  columnWidths?: Record<string, number>
}

// ============================================================================
// Component
// ============================================================================

/**
 * Summary row component that displays aggregated values in a sticky footer.
 */
export function SummaryRow({
  columns,
  notes,
  summaries,
  formulas,
  density,
  showColumnBorders,
  columnWidths
}: SummaryRowProps): React.JSX.Element | null {
  // Compute summaries for all configured columns
  const computedSummaries = useMemo(() => {
    const results: Record<string, { value: string; type: SummaryConfig['type']; label?: string }> =
      {}

    for (const column of columns) {
      const config = summaries[column.id]
      if (!config) continue

      // Get values for this column
      const values = getColumnValues(notes, column.id, formulas)

      // Compute summary
      const result = computeSummary(values, config)

      // Format for display
      const formatted = formatSummaryValue(result, config)

      results[column.id] = {
        value: formatted,
        type: config.type,
        label: config.label
      }
    }

    return results
  }, [columns, notes, summaries, formulas])

  // Don't render if no summaries are configured
  const hasSummaries = Object.keys(computedSummaries).length > 0
  if (!hasSummaries) {
    return null
  }

  return (
    <tfoot
      style={{
        display: 'grid',
        position: 'sticky',
        bottom: 0,
        zIndex: 10
      }}
      className="bg-muted/50 border-t-2 border-border"
    >
      <tr style={{ display: 'flex', width: '100%' }}>
        {columns.map((column, index) => {
          const summary = computedSummaries[column.id]
          const width = columnWidths?.[column.id] ?? column.width ?? 120
          const isLast = index === columns.length - 1

          return (
            <td
              key={column.id}
              className={cn(
                'flex-shrink-0',
                // Density-aware padding
                density === 'compact' ? 'px-2 py-1' : 'px-3 py-2',
                // Column borders (not on last column)
                showColumnBorders && !isLast && 'border-r border-border/30',
                // Text styling
                'text-sm font-medium text-muted-foreground',
                // Truncate overflow
                'overflow-hidden'
              )}
              style={
                isLast
                  ? {
                      minWidth: width,
                      flex: 1
                    }
                  : {
                      width,
                      maxWidth: width
                    }
              }
            >
              {summary ? (
                <SummaryCell value={summary.value} type={summary.type} label={summary.label} />
              ) : null}
            </td>
          )
        })}
      </tr>
    </tfoot>
  )
}

// ============================================================================
// Sub-components
// ============================================================================

interface SummaryCellProps {
  value: string
  type: SummaryConfig['type']
  label?: string
}

/**
 * Individual summary cell content.
 */
function SummaryCell({ value, type, label }: SummaryCellProps): React.JSX.Element {
  const symbol = getSummaryTypeSymbol(type)

  // For countBy, the value is already formatted with labels
  if (type === 'countBy') {
    return (
      <div className="flex items-center gap-1.5 truncate" title={value}>
        <span className="text-xs opacity-60">{symbol}</span>
        <span className="truncate text-xs">{value}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 truncate" title={`${label ?? type}: ${value}`}>
      <span className="text-xs opacity-60">{symbol}</span>
      {label && <span className="text-xs opacity-70">{label}:</span>}
      <span className="truncate">{value}</span>
    </div>
  )
}

export default SummaryRow
