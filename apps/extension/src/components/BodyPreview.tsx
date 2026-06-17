import { renderMarkdown } from '@/lib/render-markdown'

export function BodyPreview({ markdown }: { markdown: string }) {
  // Read-only preview of arbitrary web content — sanitized in renderMarkdown.
  const html = renderMarkdown(markdown)
  return (
    <div
      className="max-h-40 overflow-y-auto border-t border-border pt-2 font-serif text-[13px] leading-relaxed text-text-secondary [&_a]:underline [&_h1]:mt-2 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:font-semibold [&_p]:mb-2"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
