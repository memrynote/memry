import { type Dispatch, useRef, useEffect } from 'react'
import { Search, X } from '@/lib/icons'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { GraphFilterState, GraphFilterAction } from '@/hooks/use-graph-filters'

interface GraphSearchProps {
  filterState: GraphFilterState
  dispatch: Dispatch<GraphFilterAction>
}

export function GraphSearch({ filterState, dispatch }: GraphSearchProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
      }
      if (e.key === 'Escape' && filterState.searchQuery) {
        dispatch({ type: 'SET_SEARCH_QUERY', query: '' })
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [filterState.searchQuery, dispatch])

  return (
    <div className="absolute right-3 top-3 z-40">
      <div className="relative flex items-center">
        <Search className="absolute left-2.5 size-3.5 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          placeholder="Search nodes..."
          className="h-8 w-48 pl-8 pr-8 text-xs bg-popover/95 backdrop-blur-sm border-border"
          value={filterState.searchQuery}
          onChange={(e) => dispatch({ type: 'SET_SEARCH_QUERY', query: e.target.value })}
        />
        {filterState.searchQuery && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-1 h-5 w-5 p-0"
            onClick={() => dispatch({ type: 'SET_SEARCH_QUERY', query: '' })}
          >
            <X className="size-3 text-muted-foreground" />
          </Button>
        )}
      </div>
    </div>
  )
}
