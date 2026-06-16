/**
 * ENML pre-processing utilities.
 *
 * ENML is HTML-like XML. Before handing it to a DOM parser / HTML-to-Markdown
 * converter we make two transformations:
 *
 * 1. Strip the outer <en-note>…</en-note> wrapper and return the inner HTML.
 *    (We also strip the <?xml …?> processing instruction and <!DOCTYPE …> if
 *    present — both confuse browsers' HTML parsers.)
 *
 * 2. Convert <en-todo checked="true"/> and <en-todo checked="false"/> into
 *    standard HTML checkbox inputs so the shared html-to-markdown converter
 *    picks them up via its parseTodo() logic:
 *      <en-todo checked="true"/>  → <input type="checkbox" checked>
 *      <en-todo checked="false"/> → <input type="checkbox">
 *    The <en-todo> sits immediately before its text inside a <div> or <p>
 *    block; we wrap it in an <li> inside a <ul> so parseTodo() fires.
 *
 * <en-media> tags are left in place; the desktop importer replaces them with
 * <img src="memry-enex:<hash>"> before calling the shared converter.
 */

/** Strip XML declaration, DOCTYPE, and the <en-note> wrapper. */
function stripEnNoteWrapper(enml: string): string {
  // Remove XML declaration
  let s = enml.replace(/<\?xml[^?]*\?>/gi, '')
  // Remove DOCTYPE
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '')
  // Extract <en-note …>…</en-note> content
  const match = s.match(/<en-note(?:\s[^>]*)?>(?<inner>[\s\S]*?)<\/en-note>/i)
  return match?.groups?.inner ?? s
}

/**
 * Convert inline <en-todo …/> elements to list items with checkboxes.
 *
 * Strategy: find every <en-todo …/> and the text that follows it (up to the
 * next tag or end of block), and replace the pair with:
 *   <ul><li><input type="checkbox" [checked]> text</li></ul>
 *
 * We do this with a regex pre-pass rather than DOM parsing to keep the module
 * dependency-free (no jsdom here — that lives in the desktop importer).
 */
function convertTodos(html: string): string {
  // Match <en-todo .../> and its label — everything up to the next <en-todo> or
  // the end of the containing block. Capturing inline markup (e.g. <b>…</b>)
  // keeps bold/italic/links inside the checkbox item instead of orphaning them.
  return html.replace(
    /<en-todo\s+checked="(true|false)"\s*\/>((?:(?!<en-todo|<\/div>|<\/p>|<br\s*\/?>)[\s\S])*)/gi,
    (_match, checked, text) => {
      const checkedAttr = checked === 'true' ? ' checked' : ''
      const label = text.trim()
      return `<ul><li><input type="checkbox"${checkedAttr}>${label}</li></ul>`
    }
  )
}

/**
 * Prepare ENML content for DOM parsing + Markdown conversion.
 *
 * @param contentHtml - The raw ENML string from the .enex file (including
 *   the `<en-note>` wrapper and any XML declaration).
 * @returns Inner HTML with `<en-todo>` replaced and wrapper stripped.
 *   `<en-media>` tags are preserved for the caller to handle.
 */
export function prepareEnml(contentHtml: string): string {
  const inner = stripEnNoteWrapper(contentHtml)
  return convertTodos(inner)
}
