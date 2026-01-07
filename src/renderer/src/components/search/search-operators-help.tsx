import { HelpCircle } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'

const operators = [
  { prefix: 'path:', example: 'path:notes/work', desc: 'Search in folder path' },
  { prefix: 'file:', example: 'file:meeting', desc: 'Search by filename' },
  { prefix: 'tag:', example: 'tag:important', desc: 'Filter by tag' },
  { prefix: '[property]:', example: '[status]:done', desc: 'Filter by property value' }
]

export function SearchOperatorsHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          <HelpCircle className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="end">
        <div className="space-y-3">
          <h4 className="text-sm font-medium">Search Operators</h4>
          <div className="space-y-2">
            {operators.map((op) => (
              <div key={op.prefix} className="text-xs">
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono">{op.prefix}</code>
                <p className="text-muted-foreground mt-0.5">{op.desc}</p>
                <p className="text-muted-foreground/70 mt-0.5">e.g. {op.example}</p>
              </div>
            ))}
          </div>
          <div className="pt-2 border-t text-xs text-muted-foreground">
            Combine operators:{' '}
            <code className="bg-muted px-1 rounded">meeting tag:work path:notes</code>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
