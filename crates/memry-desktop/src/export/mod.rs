//! Note export to a self-contained HTML document, the port of Electron's
//! `apps/desktop/src/main/lib/export-utils.ts` and `export-image-inliner.ts`.
//! `packages/contracts/test-vectors/export.json` holds the Electron output this
//! module reproduces (`tests/export_vectors.rs`).

mod footnotes;
mod header;
mod icons;
mod inline_images;
mod markdown;
mod marked;

use chrono::NaiveDate;
use memry_core::markdown::shared::task_block::strip_task_block_suffixes;

pub use icons::{IconPart, library_icon};
#[cfg(feature = "test-hooks")]
pub use inline_images::image_reads;
pub use inline_images::{ImageSource, MAX_DATA_URI_LEN, inline_export_images};
#[cfg(feature = "test-hooks")]
pub use markdown::steps;

/// The note fields an export prints.
#[derive(Debug, Clone)]
pub struct NoteExport<'a> {
    pub title: &'a str,
    pub content: &'a str,
    /// The stored note icon: a bare emoji, `icon:<Name>` or `custom:<id>`.
    pub icon: Option<&'a str>,
    pub tags: &'a [String],
    /// Local calendar dates, as `toLocaleDateString` printed them.
    pub created: NaiveDate,
    pub modified: NaiveDate,
}

/// An uploaded icon row: its extension and base64 bytes.
#[derive(Debug, Clone)]
pub struct CustomIcon {
    pub ext: String,
    pub data: String,
}

pub struct RenderOptions<'a> {
    /// Icon, dates and tags in the header. On by default.
    pub include_metadata: bool,
    /// Keep each task's `{task:<id>}` suffix. Off by default.
    pub include_task_markers: bool,
    /// Looks up an uploaded icon by id, for a note whose icon is `custom:<id>`.
    pub find_custom_icon: &'a dyn Fn(&str) -> Option<CustomIcon>,
}

/// The export stylesheet, `getEmbeddedStyles()` without its leading line break
/// and trailing indent.
const STYLES: &str = include_str!("styles.css");

/// `getEmbeddedStyles()` byte for byte.
pub fn embedded_styles() -> String {
    format!("\n{STYLES}  ")
}

/// Keeps script in a note from running when the exported file is opened: raw
/// HTML passes through as `marked` passes it, `<script>`, `onerror=` and
/// `javascript:` links included. Electron's export has no such line; it is the
/// one line `tests/export_vectors.rs` takes out before comparing.
pub const CONTENT_SECURITY_POLICY: &str = "  <meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'; object-src 'none'\">\n";

/// `renderNoteAsHtml`: the note as a complete HTML document.
pub fn render_note_as_html(note: &NoteExport<'_>, options: &RenderOptions<'_>) -> String {
    let content = if options.include_task_markers {
        markdown::markdown_to_html(note.content)
    } else {
        markdown::markdown_to_html(&strip_task_block_suffixes(note.content))
    };
    let metadata = if options.include_metadata {
        header::metadata_section(note)
    } else {
        String::new()
    };
    let title = escape_html(note.title);
    format!(
        "<!DOCTYPE html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
{CONTENT_SECURITY_POLICY}  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <meta name=\"generator\" content=\"memrynote\">
  <title>{title}</title>
  <style>{styles}</style>
</head>
<body>
  <article>
    <header class=\"note-header\">
      {icon}
      <h1 class=\"note-title\">{title}</h1>
      {metadata}
    </header>
    <main class=\"note-content\">
      {content}
    </main>
  </article>
</body>
</html>",
        styles = embedded_styles(),
        icon = header::render_note_icon(note.icon, options.find_custom_icon),
    )
}

/// `escapeHtml`.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// `sanitizeFilename`: the platform-forbidden characters removed, whitespace
/// runs collapsed, trimmed, cut to 200 UTF-16 units.
pub fn sanitize_filename(filename: &str) -> String {
    let kept: String = filename
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    let mut collapsed = String::with_capacity(kept.len());
    let mut in_space = false;
    for c in kept.chars() {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let trimmed = js_trim(&collapsed);
    let units: Vec<u16> = trimmed.encode_utf16().take(200).collect();
    String::from_utf16_lossy(&units)
}

/// JavaScript's `\s` and `String.prototype.trim` set.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}
