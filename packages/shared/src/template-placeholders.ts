export function substituteTemplatePlaceholders(content: string, title: string): string {
  return content.replace(/\{\{title\}\}/g, title)
}
