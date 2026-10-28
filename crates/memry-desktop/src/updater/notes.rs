//! Release notes as plain text for the update prompt (`apps/desktop/src/main/lib/
//! html-to-plain-text.ts`, `updater-release-notes.ts`). The feed carries GitHub-rendered HTML;
//! the prompt shows plain text with the developer changelog dropped, and the release notes tab
//! keeps the HTML.

use std::sync::LazyLock;

use regex::{Captures, Regex};

/// Marks where a heading starts, so a blank line can be restored before it after every other
/// blank line is collapsed. NUL never appears in feed HTML text.
const HEADING_MARK: &str = "\u{0}";

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("static pattern")
}

static HEADING_OPEN: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)<h[1-6][^>]*>"));
static LIST_ITEM_OPEN: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)<li[^>]*>"));
static BLOCK_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)</(p|div|li|ul|ol|h[1-6]|blockquote|tr)>"));
static LINE_BREAK: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)<br\s*/?>"));
static TAG: LazyLock<Regex> = LazyLock::new(|| pattern(r"<[^>]+>"));
static ENTITY: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)&(#x?[0-9a-f]+|[a-z][a-z0-9]*);"));
static TRAILING_BLANKS: LazyLock<Regex> = LazyLock::new(|| pattern(r"[ \t]+\n"));
static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| pattern(r"\n{2,}"));
static HEADING_GAP: LazyLock<Regex> = LazyLock::new(|| pattern("\\n*\u{0}"));

fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name.to_ascii_lowercase().as_str() {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        _ => return None,
    })
}

/// The leading decimal digits of `text`, as `parseInt(text, 10)` reads them.
fn leading_decimal(text: &str) -> Option<u32> {
    let end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    text[..end].parse().ok()
}

fn decode_entity(caps: &Captures<'_>) -> String {
    let whole = &caps[0];
    let body = &caps[1];
    let decoded = match body.strip_prefix('#') {
        Some(number) => {
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => leading_decimal(number),
            };
            // JavaScript also yields a lone surrogate for D800-DFFF; Rust has no such char,
            // so those stay as written.
            code.filter(|c| (1..=0x10_FFFF).contains(c))
                .and_then(char::from_u32)
                .map(String::from)
        }
        None => named_entity(body).map(str::to_owned),
    };
    decoded.unwrap_or_else(|| whole.to_owned())
}

/// The characters `String.prototype.trim` removes.
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

/// Longest feed HTML converted. A GitHub release body is capped at 125,000 characters, so a
/// real feed never reaches it; anything longer is cut at a character boundary first.
pub const MAX_NOTES_HTML_BYTES: usize = 512 * 1024;

thread_local! {
    static STRIP_PASSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Tag-stripping passes run on this thread, for the complexity test.
#[doc(hidden)]
pub fn strip_passes() -> usize {
    STRIP_PASSES.with(std::cell::Cell::get)
}

fn capped(input: &str) -> &str {
    if input.len() <= MAX_NOTES_HTML_BYTES {
        return input;
    }
    let mut end = MAX_NOTES_HTML_BYTES;
    while !input.is_char_boundary(end) {
        end -= 1;
    }
    &input[..end]
}

/// An HTML fragment as readable plain text: bullets single-spaced, one blank line only before
/// a section heading.
pub fn html_to_plain_text(input: &str) -> String {
    let marked = HEADING_OPEN.replace_all(capped(input), HEADING_MARK);
    let marked = LIST_ITEM_OPEN.replace_all(&marked, "• ");
    let marked = BLOCK_CLOSE.replace_all(&marked, "\n");
    let mut text = LINE_BREAK.replace_all(&marked, "\n").into_owned();
    // Strip until nothing changes, as Electron does against a tag re-formed by a removal. A
    // match runs from the leftmost `<` to the next `>`, so no `<` before a removed tag can
    // pair with a `>` after it, and the second pass always finds nothing.
    loop {
        STRIP_PASSES.with(|passes| passes.set(passes.get() + 1));
        let stripped = TAG.replace_all(&text, "").into_owned();
        if stripped == text {
            break;
        }
        text = stripped;
    }
    let text = ENTITY.replace_all(&text, decode_entity);
    let text = TRAILING_BLANKS.replace_all(&text, "\n");
    // Loose lists wrap each `<li>` in a `<p>`; single-space everything.
    let text = BLANK_LINES.replace_all(&text, "\n");
    let text = HEADING_GAP.replace_all(&text, "\n\n");
    text.trim_matches(is_js_space).to_owned()
}

/// Everything above a line that reads `changelog`, which starts the developer section.
pub fn strip_developer_changelog(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    match lines
        .iter()
        .position(|line| line.trim_matches(is_js_space).to_lowercase() == "changelog")
    {
        Some(index) => lines[..index]
            .join("\n")
            .trim_end_matches(is_js_space)
            .to_owned(),
        None => text.to_owned(),
    }
}

/// The prompt body: plain text without the developer changelog, or `None` when nothing is left.
pub fn plain_text_release_notes(html: &str) -> Option<String> {
    Some(strip_developer_changelog(&html_to_plain_text(html))).filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_the_electron_cases() {
        let cases = [
            (
                "<h2>Fixes</h2><ul><li>Sync fix</li><li>Calendar fix</li></ul>",
                "Fixes\n• Sync fix\n• Calendar fix",
            ),
            (
                "<p>First line</p><p>Second<br>third</p>",
                "First line\nSecond\nthird",
            ),
            (
                "Tom &amp; Jerry &#39;quoted&#39; &#x2014; done &nbsp;here",
                "Tom & Jerry 'quoted' — done  here",
            ),
            (
                "Fixed <a href=\"https://x/pull/529\">#529</a> and <code>foo</code>",
                "Fixed #529 and foo",
            ),
            ("  <p>One</p>\n\n\n\n<p>Two</p>  ", "One\nTwo"),
            (
                "<h2>New Features</h2><ul><li><p>Feature one (#1)</p></li><li><p>Feature two (#2)</p></li></ul><h2>Bug Fixes</h2><ul><li><p>Bug one (#3)</p></li></ul>",
                "New Features\n• Feature one (#1)\n• Feature two (#2)\n\nBug Fixes\n• Bug one (#3)",
            ),
            ("Just plain release notes", "Just plain release notes"),
            ("", ""),
        ];
        for (html, expected) in cases {
            assert_eq!(html_to_plain_text(html), expected, "{html}");
        }
    }

    #[test]
    fn a_script_body_loses_its_tags_and_keeps_only_text() {
        let text = html_to_plain_text("<p>Before</p><script>alert('x')</script><p>After</p>");
        assert_eq!(text, "Before\nalert('x')After");
        assert!(!text.contains('<'));
    }

    #[test]
    fn nested_broken_tags_leave_no_tag_behind() {
        // Expected values are the output of the Electron function for the same input.
        let text = html_to_plain_text("a<<b>script>alert(1)<</b>/script>z");
        assert_eq!(text, "ascript>alert(1)/script>z");
        assert!(!TAG.is_match(&text));
        assert_eq!(html_to_plain_text("<<<i>i>b>x"), "i>b>x");
    }

    #[test]
    fn decodes_entities_the_way_the_javascript_does() {
        assert_eq!(
            html_to_plain_text("&LT;b&GT; &#X41; &#65; &#0; &bogus;"),
            "<b> A A &#0; &bogus;"
        );
        // `parseInt("12ab", 10)` reads the leading digits.
        assert_eq!(html_to_plain_text("&#65ab;"), "A");
        assert_eq!(html_to_plain_text("&#99999999999;"), "&#99999999999;");
    }

    #[test]
    fn drops_the_developer_changelog() {
        let html = "<h2>Highlights</h2><ul><li>Faster sync</li></ul><h2>Changelog</h2><ul><li>refactor (#12)</li></ul>";
        assert_eq!(
            plain_text_release_notes(html).as_deref(),
            Some("Highlights\n• Faster sync")
        );
        assert_eq!(
            strip_developer_changelog("No section here\n  more"),
            "No section here\n  more"
        );
    }

    #[test]
    fn notes_that_are_only_a_changelog_are_none() {
        assert_eq!(plain_text_release_notes("<h2>Changelog</h2><p>x</p>"), None);
        assert_eq!(plain_text_release_notes("   "), None);
    }
}
