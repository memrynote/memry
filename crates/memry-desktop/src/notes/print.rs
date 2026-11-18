//! The document the PDF export prints: the HTML export's document (`NotesService::note_html`)
//! with backgrounds kept. Electron's `printToPDF({ printBackground: true })` asks Chromium to
//! print them; WebKit drops them unless the page asks, so every engine gets the CSS too.

/// Keeps code block and table backgrounds in the print, as `printBackground: true` does.
pub const PRINT_BACKGROUNDS: &str = "<style>@media print { * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }</style>\n";

/// What the print window's page may load: its own inline styles and the `data:` images the export
/// inlined, and no script, as Electron's print window ran with `javascript: false`.
pub const PRINT_CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/// `html` with [`PRINT_BACKGROUNDS`] at the end of its head. The export's template always has a
/// head, so the first `</head>` is the template's; a note body comes after it.
pub fn print_document(html: &str) -> String {
    match html.find("</head>") {
        Some(at) => format!("{}{PRINT_BACKGROUNDS}{}", &html[..at], &html[at..]),
        None => format!("{PRINT_BACKGROUNDS}{html}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_style_goes_before_the_templates_head_end() {
        let html = "<html><head><title>t</title></head><body><pre>&lt;/head&gt;</pre></head></body></html>";
        assert_eq!(
            print_document(html),
            format!(
                "<html><head><title>t</title>{PRINT_BACKGROUNDS}</head><body><pre>&lt;/head&gt;</pre></head></body></html>"
            )
        );
    }

    #[test]
    fn a_document_without_a_head_still_gets_the_style() {
        assert_eq!(
            print_document("<p>x</p>"),
            format!("{PRINT_BACKGROUNDS}<p>x</p>")
        );
    }
}
