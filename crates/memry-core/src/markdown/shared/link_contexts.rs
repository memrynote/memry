//! `extractAllLinkContexts` (desktop `vault/notes-queries.ts`): every `[[Title]]` and
//! `[[Title|text]]` in a note's text that names `title`, with the text around it, which the
//! backlinks panel shows under each linking note.
//!
//! The rules of the reference's regular expression `\[\[<title>(?:\|[^\]]+)?\]\]`, flag `gi`:
//!   * the title is matched literally, case-insensitively the way a non-Unicode JavaScript
//!     regular expression folds: a code unit that upper-cases to one code unit, and never a
//!     non-ASCII one to ASCII (`ſ` is not `s`), so characters outside the BMP match only
//!     themselves;
//!   * `|text` holds at least one character and no `]`, and the link ends at `]]`;
//!   * matches do not overlap, and a failed match moves on by one character.
//!
//! A context is the text from [`CONTEXT_RADIUS`] UTF-16 units before the link to as many after
//! it, `...` where it was cut, every run of newlines read as one space, trimmed. Offsets are
//! UTF-16 units into the snippet, as the renderer slices it.
//!
//! Differences from the reference, both stated: the reference measures `linkStart` before it
//! folds newlines and trims, so a highlight after a folded run is off by the characters it
//! dropped; here the offsets name the link in the snippet as returned. A cut never splits a
//! surrogate pair: the reference can leave half of one at a cut.
//!
//! Untrusted input: the scan keeps one cached position of the next `]`, so it is linear in the
//! text times the title's length ([`steps`]), and the snippets of one text stop once they hold
//! eight times its bytes plus 64.

use std::cell::Cell;

/// UTF-16 units of text kept on each side of a link.
pub const CONTEXT_RADIUS: usize = 75;

const LEAD: &str = "...";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkContext {
    pub snippet: String,
    /// UTF-16 offset of the link in `snippet`.
    pub link_start: usize,
    /// UTF-16 offset just past the link in `snippet`.
    pub link_end: usize,
}

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Characters the scans on this thread have looked at, for the complexity tests.
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

fn step(n: usize) {
    STEPS.with(|steps| steps.set(steps.get() + n));
}

/// One character as a non-Unicode JavaScript `i` regular expression compares it.
fn canon(c: char) -> char {
    if c > '\u{FFFF}' {
        return c;
    }
    let mut upper = c.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(u), None) if u <= '\u{FFFF}' && !(!c.is_ascii() && u.is_ascii()) => u,
        _ => c,
    }
}

/// Every link to `title` in `content`, in order.
pub fn link_contexts(content: &str, title: &str) -> Vec<LinkContext> {
    let title: Vec<char> = title.chars().map(canon).collect();
    if title.is_empty() {
        return Vec::new();
    }
    let budget = 8 * content.len() + 64;
    let mut used = 0;
    let mut out = Vec::new();
    // The byte index of the first `]` at or after a position the scan passed, or the length
    // when there is none; positions only grow, so it is found again only once passed.
    let mut next_close: Option<usize> = None;
    let mut at = 0;
    while let Some(found) = content[at..].find("[[") {
        step(found + 2);
        let open = at + found;
        let mut pos = open + 2;
        let mut named = true;
        for (want, have) in title
            .iter()
            .zip(content[pos..].chars().chain(std::iter::repeat('\0')))
        {
            step(1);
            if have == '\0' || canon(have) != *want {
                named = false;
                break;
            }
            pos += have.len_utf8();
        }
        let end = if !named {
            None
        } else if content[pos..].starts_with("]]") {
            Some(pos + 2)
        } else if content[pos..].starts_with('|') {
            let from = pos + 1;
            let close = match next_close {
                Some(close) if close >= from => close,
                _ => {
                    let close = content[from..]
                        .find(']')
                        .map_or(content.len(), |i| from + i);
                    step(close - from);
                    next_close = Some(close);
                    close
                }
            };
            (close > from && content[close..].starts_with("]]")).then_some(close + 2)
        } else {
            None
        };
        let Some(end) = end else {
            at = open + 1;
            continue;
        };
        let context = around(content, open, end);
        used += context.snippet.len();
        if used > budget {
            break;
        }
        out.push(context);
        at = end;
    }
    out
}

fn around(content: &str, open: usize, end: usize) -> LinkContext {
    let mut units = 0;
    let start = content[..open]
        .char_indices()
        .rev()
        .take_while(|(_, c)| {
            units += c.len_utf16();
            units <= CONTEXT_RADIUS
        })
        .last()
        .map_or(open, |(i, _)| i);
    units = 0;
    let stop = content[end..]
        .char_indices()
        .take_while(|(_, c)| {
            units += c.len_utf16();
            units <= CONTEXT_RADIUS
        })
        .last()
        .map_or(end, |(i, c)| end + i + c.len_utf8());
    step(stop - start);

    let lead = if start > 0 { LEAD } else { "" };
    let trail = if stop < content.len() { LEAD } else { "" };
    let raw = format!("{lead}{}{trail}", &content[start..stop]);
    let (link_open, link_close) = (lead.len() + open - start, lead.len() + end - start);

    // Newline runs folded, with the link's UTF-16 offsets taken as the text is built.
    let mut snippet = String::with_capacity(raw.len());
    let (mut units, mut link_start, mut link_end) = (0, 0, 0);
    let mut in_run = false;
    for (i, c) in raw.char_indices() {
        if i == link_open {
            link_start = units;
        }
        if i == link_close {
            link_end = units;
        }
        if c == '\n' {
            if !in_run {
                snippet.push(' ');
                units += 1;
            }
            in_run = true;
            continue;
        }
        in_run = false;
        snippet.push(c);
        units += c.len_utf16();
    }
    if link_close == raw.len() {
        link_end = units;
    }

    // JavaScript's `trim`: Unicode white space and U+FEFF, not U+0085.
    let blank = |c: char| c != '\u{0085}' && (c.is_whitespace() || c == '\u{FEFF}');
    let kept = snippet.trim_start_matches(blank);
    let dropped: usize = snippet[..snippet.len() - kept.len()]
        .chars()
        .map(char::len_utf16)
        .sum();
    let kept = kept.trim_end_matches(blank);
    let total: usize = kept.chars().map(char::len_utf16).sum();
    LinkContext {
        snippet: kept.to_owned(),
        link_start: link_start.saturating_sub(dropped).min(total),
        link_end: link_end.saturating_sub(dropped).min(total),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(content: &str, title: &str) -> Vec<(String, String)> {
        link_contexts(content, title)
            .into_iter()
            .map(|context| {
                let units: Vec<u16> = context.snippet.encode_utf16().collect();
                let link = String::from_utf16(&units[context.link_start..context.link_end])
                    .expect("the offsets fall between characters");
                (context.snippet, link)
            })
            .collect()
    }

    #[test]
    fn plain_and_aliased_links_any_case() {
        assert_eq!(
            shown(
                "See [[Plan]] and [[plan|the plan]] but not [[Planner]].",
                "Plan"
            ),
            [
                (
                    "See [[Plan]] and [[plan|the plan]] but not [[Planner]].".to_owned(),
                    "[[Plan]]".to_owned()
                ),
                (
                    "See [[Plan]] and [[plan|the plan]] but not [[Planner]].".to_owned(),
                    "[[plan|the plan]]".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn an_empty_alias_or_an_unclosed_one_is_no_link() {
        assert!(shown("[[Plan|]] [[Plan|x] y", "Plan").is_empty());
        assert_eq!(shown("[[Plan|a\nb]]", "Plan")[0].1, "[[Plan|a b]]");
    }

    #[test]
    fn long_text_is_cut_with_dots_and_newline_runs_fold() {
        let before = "a".repeat(100);
        let after = "b".repeat(100);
        let found = shown(&format!("{before}\n\n\n[[Plan]]\n{after}"), "Plan");
        let (snippet, link) = &found[0];
        assert_eq!(link, "[[Plan]]");
        assert_eq!(
            snippet,
            &format!("...{} [[Plan]] {}...", "a".repeat(72), "b".repeat(74))
        );
    }

    #[test]
    fn javascript_case_folding_without_the_unicode_flag() {
        assert_eq!(shown("[[STRASSE]]", "straße").len(), 0);
        assert_eq!(shown("[[S]]", "ſ").len(), 0);
        assert_eq!(shown("[[ÉTÉ]]", "été").len(), 1);
    }
}
