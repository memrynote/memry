import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Lock, Loader2, FileText } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { ContentArea } from '@/components/note/content-area'
import { useTemplates } from '@/hooks/use-templates'
import { useT } from '@memry/i18n/renderer'

interface TemplatePreviewProps {
  templateId: string
  onBack: () => void
}

export function TemplatePreview({ templateId, onBack }: TemplatePreviewProps) {
  const { t } = useT('settings')
  const { getTemplate } = useTemplates({ autoLoad: false })

  const { data: template, isLoading } = useQuery({
    queryKey: ['template-preview', templateId],
    queryFn: () => getTemplate(templateId)
  })

  return (
    <div className="flex flex-col text-xs/4">
      <div className="mb-3">
        <Button variant="ghost" size="sm" className="gap-1.5 -ms-2" onClick={onBack}>
          <ArrowLeft className="w-3.5 h-3.5" />
          {t('templates.header.title')}
        </Button>
      </div>

      {isLoading || !template ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2.5 mb-1">
            <span className="text-muted-foreground shrink-0">
              {template.icon || <FileText className="w-4 h-4" />}
            </span>
            <h2 className="font-semibold text-sm text-foreground">{template.name}</h2>
            {template.isBuiltIn && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
                <Lock className="w-3 h-3" />
                {t('templates.groups.builtIn')}
              </span>
            )}
          </div>
          {template.description && (
            <p className="text-xs/4 text-muted-foreground mb-4">{template.description}</p>
          )}

          {/* ponytail: minimal read-only property list; swap for InfoSection if exact editor parity is wanted */}
          {template.properties.length > 0 && (
            <div className="mb-4 rounded-md border border-border divide-y divide-border">
              {template.properties.map((prop) => (
                <div key={prop.name} className="flex items-center justify-between px-3 py-1.5">
                  <span className="text-foreground">{prop.name}</span>
                  <span className="text-muted-foreground">{prop.type}</span>
                </div>
              ))}
            </div>
          )}

          <div className="min-h-[200px] rounded-md border border-border p-4 bg-card">
            <ContentArea
              key={templateId}
              initialContent={template.content}
              contentType="markdown"
              editable={false}
            />
          </div>
        </>
      )}
    </div>
  )
}
