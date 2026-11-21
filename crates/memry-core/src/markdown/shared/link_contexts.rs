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
//! The text around the links is the plain text a note preview shows
//! ([`markdown_plain_text`]: no style spans, heading marks, link targets or emphasis markers,
//! white space collapsed), with each link kept as written, its newline runs read as one space
//! (#3509). Each link stands in the projection as [`LINK_MARK`], which no pattern may drop, so
//! every link is in the plain text, in order: a link nested where the projection would drop
//! text (a markdown link's target, an image) keeps that text as written.
//!
//! A context is the plain text from [`CONTEXT_RADIUS`] UTF-16 units before the link to as many
//! after it, `...` where it was cut. Offsets are UTF-16 units into the snippet, as the renderer
//! slices it. A cut never splits a surrogate pair.
//!
//! Untrusted input: the scan keeps one cached position of the next `]`, so it is linear in the
//! text times the title's length ([`steps`]), and the snippets of one text stop once they hold
//! eight times its bytes plus 64. A snippet can hold up to 150 UTF-16 units around a link a
//! dozen bytes long, so a note dense with links reaches that bound: a table with one link per
//! short row does. The scan still counts every link, so [`LinkContexts::count`] is the
//! reference's `contexts.length` and [`LinkContexts::truncated`] says snippets are missing.

use std::cell::Cell;

use crate::domain::journal_rules::preview::markdown_plain_text;

/// UTF-16 units of text kept on each side of a link.
pub const CONTEXT_RADIUS: usize = 75;

const LEAD: &str = "...";

/// A noncharacter, which text interchange never carries: one in the note reads as U+FFFD, so a
/// mark always names a link.
const LINK_MARK: char = '\u{FDD0}';

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

/// The links to one title in one text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkContexts {
    /// The text around each link, in order, until the output bound.
    pub contexts: Vec<LinkContext>,
    /// Every link, those past the bound included.
    pub count: usize,
    /// Some links have no snippet: `contexts` stopped at the output bound.
    pub truncated: bool,
}

/// Every link to `title` in `content`, in order.
pub fn link_contexts(content: &str, title: &str) -> LinkContexts {
    let title: Vec<char> = title.chars().map(canon).collect();
    let mut out = LinkContexts::default();
    if title.is_empty() {
        return out;
    }
    let mut links = Vec::new();
    // The byte index of the first `]` at or after `from` for the latest `from` that needed one,
    // or the length when there is none. Each `from` is past the last, so a cached `]` still at
    // or after it is the first one, and the text is searched for `]` only once overall.
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
        out.count += 1;
        at = end;
        links.push(open..end);
    }
    if links.is_empty() {
        return out;
    }

    let (text, spans) = plain_text_with_links(content, &links);
    let budget = 8 * content.len() + 64;
    let mut used = 0;
    for (open, end) in spans {
        let context = around(&text, open, end);
        used += context.snippet.len();
        if used > budget {
            out.truncated = true;
            break;
        }
        out.contexts.push(context);
    }
    out
}

/// `content` as plain text with every link in `links` as written, and the byte range of each
/// link in that text.
fn plain_text_with_links(
    content: &str,
    links: &[std::ops::Range<usize>],
) -> (String, Vec<(usize, usize)>) {
    let unmark = |c: char| if c == LINK_MARK { '\u{FFFD}' } else { c };
    let mut marked = String::with_capacity(content.len());
    let mut from = 0;
    for link in links {
        marked.extend(content[from..link.start].chars().map(unmark));
        marked.push(LINK_MARK);
        from = link.end;
    }
    marked.extend(content[from..].chars().map(unmark));
    let plain = markdown_plain_text(&marked, Some(LINK_MARK));
    step(plain.len());

    let mut text = String::with_capacity(plain.len() + content.len());
    let mut spans = Vec::with_capacity(links.len());
    let mut next = links.iter();
    for c in plain.chars() {
        let Some(link) = (c == LINK_MARK).then(|| next.next()).flatten() else {
            text.push(c);
            continue;
        };
        let open = text.len();
        let mut in_run = false;
        for c in content[link.clone()].chars() {
            if c != '\n' {
                text.push(c);
            } else if !in_run {
                text.push(' ');
            }
            in_run = c == '\n';
        }
        spans.push((open, text.len()));
    }
    (text, spans)
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
    let units = |text: &str| text.encode_utf16().count();
    let link_start = lead.len() + units(&content[start..open]);
    LinkContext {
        snippet: format!("{lead}{}{trail}", &content[start..stop]),
        link_start,
        link_end: link_start + units(&content[open..end]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(content: &str, title: &str) -> Vec<(String, String)> {
        link_contexts(content, title)
            .contexts
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
                    "See [[Plan]] and [[plan|the plan]] but not Planner.".to_owned(),
                    "[[Plan]]".to_owned()
                ),
                (
                    "See [[Plan]] and [[plan|the plan]] but not Planner.".to_owned(),
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
            &format!("...{} [[Plan]] {}...", "a".repeat(74), "b".repeat(74))
        );
    }

    #[test]
    fn links_do_not_overlap() {
        // The alias runs to the first `]]`, so the inner link is part of the outer one.
        assert_eq!(
            shown("[[Plan|see [[Plan]] here", "Plan"),
            [(
                "[[Plan|see [[Plan]] here".to_owned(),
                "[[Plan|see [[Plan]]".to_owned()
            )]
        );
    }

    #[test]
    fn a_dense_table_counts_every_link_past_the_output_bound() {
        let table: String = (0..30).map(|i| format!("| {i} | [[Plan]] |\n")).collect();
        let found = link_contexts(&table, "Plan");
        assert_eq!(found.count, 30);
        assert!(found.truncated);
        assert_eq!(found.contexts.len(), 27);
        let short = link_contexts("[[Plan]] and [[plan]]", "Plan");
        assert_eq!(
            (short.count, short.truncated, short.contexts.len()),
            (2, false, 2)
        );
    }

    #[test]
    fn the_text_around_a_link_is_plain_text() {
        let source = "# Notes\nPlain <span style=\"color:#e03e3e\">red</span> \
            <span style=\"text-decoration:underline\">under</span> **bold**[[Plan]]\
            <span style=\"color:blue\">_tail_</span> [site](https://x.y) end.";
        assert_eq!(
            shown(source, "Plan"),
            [(
                "Notes Plain red under bold[[Plan]]tail site end.".to_owned(),
                "[[Plan]]".to_owned()
            )]
        );
        // Emphasis around the link goes; a link nested where the text would drop it stays.
        assert_eq!(
            shown("**see [[Plan]]** and [site]([[Plan]])", "Plan"),
            [
                (
                    "see [[Plan]] and [site]([[Plan]])".to_owned(),
                    "[[Plan]]".to_owned()
                ),
                (
                    "see [[Plan]] and [site]([[Plan]])".to_owned(),
                    "[[Plan]]".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn javascript_case_folding_without_the_unicode_flag() {
        assert_eq!(shown("[[STRASSE]]", "straße").len(), 0);
        assert_eq!(shown("[[S]]", "ſ").len(), 0);
        assert_eq!(shown("[[ÉTÉ]]", "été").len(), 1);
    }
}
