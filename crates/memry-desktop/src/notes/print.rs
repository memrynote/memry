//! The document the PDF export prints: the HTML export's document (`NotesService::note_html`)
//! with backgrounds kept and `<link>` tags taken out. Electron's
//! `printToPDF({ printBackground: true })` asks Chromium to print them; WebKit drops them unless
//! the page asks, so every engine gets the CSS too.

/// Keeps code block and table backgrounds in the print, as `printBackground: true` does.
pub const PRINT_BACKGROUNDS: &str = "<style>@media print { * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }</style>\n";

/// What the print window's page may load: its own inline styles and the `data:` images the export
/// inlined, and no script, as Electron's print window ran with `javascript: false`. A remote image
/// or frame in a note's raw HTML prints as nothing, where Electron's window loaded it (a departure
/// recorded on #3551): the note's content is untrusted and printing must not reach the network.
pub const PRINT_CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/// `html` with its `<link>` tags taken out and [`PRINT_BACKGROUNDS`] at the end of its head. The
/// export's template always has a head, so the first `</head>` is the template's; a note body
/// comes after it.
pub fn print_document(html: String) -> String {
    let mut html = strip_links(html);
    let at = html.find("</head>").unwrap_or(0);
    html.insert_str(at, PRINT_BACKGROUNDS);
    html
}

/// `html` with every `<link` tag replaced by [`GAP`]. A note's raw HTML passes into the export
/// (`export::marked`), and a `<link rel=preconnect|dns-prefetch|prefetch|preload>` reaches the
/// network before, or outside, what [`PRINT_CSP`] governs. The template has no `<link>`. A tag
/// ends at its first `>` (or the end of the document): a quoted `>` leaves the rest of the tag as
/// text, which loads nothing. Linear: each byte is looked at once, plus the five after a `<`.
/// What a removed tag leaves: a zero-width space. It is not ASCII, so it is none of `<link`'s
/// bytes and ends no tag name, and the text on either side cannot join into a new `<link` tag
/// across it (`<link<link>` would join into `<link ` around a space). Invisible where it prints.
const GAP: char = '\u{200B}';

fn strip_links(html: String) -> String {
    let bytes = html.as_bytes();
    // Allocated at the first `<link`; a document without one comes back as it was.
    let mut kept: Option<String> = None;
    let mut from = 0;
    let mut in_link = false;
    for (at, &byte) in bytes.iter().enumerate() {
        #[cfg(test)]
        steps::count();
        if in_link {
            if byte == b'>' {
                in_link = false;
                from = at + 1;
            }
        } else if byte == b'<' && opens_link(&bytes[at..]) {
            let out = kept.get_or_insert_with(|| String::with_capacity(html.len()));
            out.push_str(&html[from..at]);
            out.push(GAP);
            in_link = true;
        }
    }
    match kept {
        None => html,
        Some(mut out) => {
            if !in_link {
                out.push_str(&html[from..]);
            }
            out
        }
    }
}

/// `<link` as the HTML tokenizer reads a tag name: any case, ended by whitespace, `/`, `>` or the
/// end of the input.
fn opens_link(rest: &[u8]) -> bool {
    rest.get(1..5)
        .is_some_and(|name| name.eq_ignore_ascii_case(b"link"))
        && rest
            .get(5)
            .is_none_or(|end| matches!(end, b'\t' | b'\n' | 0x0C | b'\r' | b' ' | b'/' | b'>'))
}

#[cfg(test)]
mod steps {
    use std::cell::Cell;

    thread_local! {
        static STEPS: Cell<usize> = const { Cell::new(0) };
    }

    pub fn count() {
        STEPS.with(|steps| steps.set(steps.get() + 1));
    }

    pub fn read() -> usize {
        STEPS.with(Cell::get)
    }
}

#[cfg(test)]
mod tests {
    use memry_test_kit::{assert_steps_at_most, on_small_stack, output_bound, proptest_config};
    use proptest::prelude::*;

    use super::*;

    /// True when a `<link` tag the browser would build is left in `html`.
    fn has_link(html: &str) -> bool {
        (0..html.len()).any(|at| html.as_bytes()[at] == b'<' && opens_link(&html.as_bytes()[at..]))
    }

    #[test]
    fn the_style_goes_before_the_templates_head_end() {
        let html = "<html><head><title>t</title></head><body><pre>&lt;/head&gt;</pre></head></body></html>";
        assert_eq!(
            print_document(html.to_owned()),
            format!(
                "<html><head><title>t</title>{PRINT_BACKGROUNDS}</head><body><pre>&lt;/head&gt;</pre></head></body></html>"
            )
        );
    }

    #[test]
    fn a_document_without_a_head_still_gets_the_style() {
        assert_eq!(
            print_document("<p>x</p>".to_owned()),
            format!("{PRINT_BACKGROUNDS}<p>x</p>")
        );
    }

    #[test]
    fn resource_hints_in_a_notes_html_are_taken_out() {
        let body = concat!(
            "<p>a</p><link rel=preconnect href=https://x.invalid>",
            "<LINK REL=\"dns-prefetch\" HREF=\"//x.invalid\"/>",
            "<link\trel=prefetch href=https://x.invalid/p>",
            "<Link rel=preload as=image href=https://x.invalid/i.png><p>b</p>",
        );
        let printed = print_document(format!("<html><head></head><body>{body}</body></html>"));
        assert!(!has_link(&printed), "{printed}");
        assert!(printed.contains("<p>a</p>\u{200B}"), "{printed}");
        assert!(
            printed.ends_with("\u{200B}<p>b</p></body></html>"),
            "{printed}"
        );
    }

    #[test]
    fn a_removed_tag_cannot_join_its_neighbours_into_a_new_one() {
        for html in [
            "<<link >link rel=preconnect href=https://x.invalid>",
            "<link<link>",
            "<LINK<link/>\trel=preconnect href=https://x.invalid>",
            "<lin<link>k rel=preconnect href=https://x.invalid>",
            "<link href=\"a>b\" rel=preconnect>",
            "<link rel=preconnect href=https://x.invalid",
            "<link",
        ] {
            let printed = strip_links(html.to_owned());
            assert!(!has_link(&printed), "{html:?} -> {printed:?}");
        }
    }

    #[test]
    fn other_tags_and_text_stay() {
        let html = "<p>&lt;link rel=preconnect&gt;</p><linked>x</linked><a href=\"#\">link</a>";
        assert_eq!(strip_links(html.to_owned()), html);
    }

    #[test]
    fn stripping_is_linear_in_the_input() {
        let html = "<link rel=preconnect href=https://x.invalid>".repeat(20_000)
            + &"<p><<<lin".repeat(20_000);
        let len = html.len();
        assert_steps_at_most("strip_links", steps::read, len, || {
            let _ = strip_links(html);
        });
    }

    #[test]
    fn deeply_nested_markup_prints_on_a_small_stack() {
        let html =
            "<div>".repeat(200_000) + "<link rel=preconnect href=x>" + &"</div>".repeat(200_000);
        let printed = on_small_stack(move || print_document(html));
        assert!(!has_link(&printed));
    }

    proptest! {
        #![proptest_config(proptest_config(256))]

        #[test]
        fn no_link_survives_and_the_output_stays_bounded(
            parts in prop::collection::vec(
                prop_oneof![
                    Just("<link".to_owned()),
                    Just("<LiNk".to_owned()),
                    Just("<lin".to_owned()),
                    Just("k".to_owned()),
                    Just("<".to_owned()),
                    Just(">".to_owned()),
                    Just(" ".to_owned()),
                    Just("/".to_owned()),
                    Just("\"".to_owned()),
                    Just("rel=preconnect href=https://x.invalid".to_owned()),
                    "[a-zA-Z<>/ \t\"'=é]{0,8}",
                ],
                0..64,
            )
        ) {
            let html = parts.concat();
            let input = html.len();
            let printed = print_document(html);
            prop_assert!(!has_link(&printed), "{printed:?}");
            prop_assert!(printed.len() <= input + PRINT_BACKGROUNDS.len());
            prop_assert!(printed.len() <= output_bound(input) + PRINT_BACKGROUNDS.len());
        }
    }
}
