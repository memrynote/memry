//! Unlinked mentions in a markdown body: `findUnlinkedMentions` and `linkUnlinkedMention` of
//! `packages/shared/src/unlinked-mentions.ts`, pinned by the `markdown` cases of the
//! `unlinked-mentions` vectors (chapter 12 §12.7.3).
//!
//! The text is scanned with [`find_plain_mentions`] after code, comments, wiki links, markdown
//! links and URLs are blanked to spaces of the same UTF-16 length, so a mention is never read
//! inside them; offsets map back to the markdown through UTF-16 units, as the reference's
//! offsets index the same string.
//!
//! Untrusted input: the linked-run scan stops each look-ahead at the next bracket, parenthesis,
//! space or line end, so it is linear in the text ([`steps`]). Like the core's
//! [`find_plain_mentions`], "letter or digit" before a URL is Rust's alphanumeric, which counts
//! a few combining marks the reference's `\p{L}\p{N}` does not.

use std::cell::Cell;

use crate::domain::unlinked_mentions::{PlainMention, find_plain_mentions};
use crate::markdown::frontmatter::js::is_js_whitespace;
use crate::markdown::shared::link_contexts::{LinkContext, LinkContexts};
use crate::markdown::shared::markdown_code::{mask_markdown_code, replace_markdown_comments};

/// UTF-16 units of text kept on each side of a mention (`SNIPPET_RADIUS`).
pub const MENTION_RADIUS: usize = 60;

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Characters the linked-run scans on this thread have looked at, for the complexity tests.
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

fn step() {
    STEPS.with(|steps| steps.set(steps.get() + 1));
}

/// Every mention of `names` in `markdown` (frontmatter already split off), in order, with byte
/// offsets into `markdown` and the text as written there.
pub fn find_unlinked_mentions(markdown: &str, names: &[String]) -> Vec<PlainMention> {
    let masked = mask(markdown);
    let found = find_plain_mentions(&masked, names);
    let mut bounds: Vec<usize> = found.iter().flat_map(|m| [m.start, m.end]).collect();
    to_original(&masked, markdown, &mut bounds);
    bounds
        .chunks(2)
        .map(|pair| PlainMention {
            start: pair[0],
            end: pair[1],
            text: markdown[pair[0]..pair[1]].to_owned(),
        })
        .collect()
}

/// `markdown` with its `ordinal`-th mention turned into `[[title|text]]`, or `[[title]]` when
/// the text spells the title. `None` when there is no such mention (the body changed since the
/// list was read).
pub fn link_unlinked_mention(
    markdown: &str,
    names: &[String],
    ordinal: usize,
    title: &str,
) -> Option<String> {
    let mention = find_unlinked_mentions(markdown, names)
        .into_iter()
        .nth(ordinal)?;
    let link = if mention.text == title {
        format!("[[{title}]]")
    } else {
        format!("[[{title}|{}]]", mention.text)
    };
    Some(format!(
        "{}{link}{}",
        &markdown[..mention.start],
        &markdown[mention.end..]
    ))
}

/// The text around each mention (`snippetAround` of desktop `vault/unlinked-mentions.ts`):
/// [`MENTION_RADIUS`] UTF-16 units each side, `…` where it was cut, every white space read as
/// one space. Offsets are UTF-16 units into the snippet. A cut never splits a surrogate pair
/// (the reference can leave half of one), and the snippets stop once they hold eight times the
/// text's bytes plus 64 (untrusted input; the reference has no bound): `count` still counts
/// every mention, and `truncated` says some have no snippet.
pub fn mention_contexts(markdown: &str, mentions: &[PlainMention]) -> LinkContexts {
    let budget = 8 * markdown.len() + 64;
    let mut used = 0;
    let contexts: Vec<LinkContext> = mentions
        .iter()
        .map(|mention| {
            let from = back(markdown, mention.start, MENTION_RADIUS);
            let to = forward(markdown, mention.end, MENTION_RADIUS);
            let lead = if from > 0 { "…" } else { "" };
            let trail = if to < markdown.len() { "…" } else { "" };
            let snippet: String = format!("{lead}{}{trail}", &markdown[from..to])
                .chars()
                .map(|c| if is_js_whitespace(c) { ' ' } else { c })
                .collect();
            let units = |text: &str| text.encode_utf16().count();
            let link_start = units(lead) + units(&markdown[from..mention.start]);
            LinkContext {
                snippet,
                link_start,
                link_end: link_start + units(&mention.text),
            }
        })
        .take_while(|context| {
            used += context.snippet.len();
            used <= budget
        })
        .collect();
    LinkContexts {
        truncated: contexts.len() < mentions.len(),
        count: mentions.len(),
        contexts,
    }
}

/// The byte index `radius` UTF-16 units before `at`, never inside a character.
fn back(text: &str, at: usize, radius: usize) -> usize {
    let mut units = 0;
    text[..at]
        .char_indices()
        .rev()
        .take_while(|(_, c)| {
            units += c.len_utf16();
            units <= radius
        })
        .last()
        .map_or(at, |(i, _)| i)
}

fn forward(text: &str, at: usize, radius: usize) -> usize {
    let mut units = 0;
    text[at..]
        .char_indices()
        .take_while(|(_, c)| {
            units += c.len_utf16();
            units <= radius
        })
        .last()
        .map_or(at, |(i, c)| at + i + c.len_utf8())
}

/// `maskMarkdown`: code, comments and linked runs blanked, every UTF-16 unit to a space.
fn mask(markdown: &str) -> String {
    let blank = |run: &str| -> String {
        run.chars()
            .map(|c| {
                if c == '\n' {
                    "\n".to_owned()
                } else {
                    " ".repeat(c.len_utf16())
                }
            })
            .collect()
    };
    let masked = replace_markdown_comments(
        &mask_markdown_code(markdown),
        &mut |source, _, _| blank(source),
        "<!--",
        "<!--",
    );
    let mut out = String::with_capacity(masked.len());
    let mut at = 0;
    let mut last = 0;
    while at < masked.len() {
        if let Some(end) = linked_run(&masked, at) {
            out.push_str(&masked[last..at]);
            out.push_str(&blank(&masked[at..end]));
            at = end;
            last = end;
            continue;
        }
        at += masked[at..].chars().next().map_or(1, char::len_utf8);
    }
    out.push_str(&masked[last..]);
    out
}

/// The end of the `LINKED_RUNS` match at `at`, if one starts there: a wiki link or embed, a
/// markdown link or image, or a URL that starts a word.
fn linked_run(text: &str, at: usize) -> Option<usize> {
    let bracket = at + usize::from(text[at..].starts_with('!'));
    if text[bracket..].starts_with('[') {
        let not_bracket = |c: char| !matches!(c, '[' | ']' | '\n');
        if text[bracket..].starts_with("[[") {
            let close = run(text, bracket + 2, not_bracket);
            if text[close..].starts_with("]]") {
                return Some(close + 2);
            }
        }
        let close = run(text, bracket + 1, not_bracket);
        if text[close..].starts_with("](") {
            let end = run(text, close + 2, |c| {
                !matches!(c, '(' | ')') && !is_js_whitespace(c)
            });
            if text[end..].starts_with(')') {
                return Some(end + 1);
            }
        }
        return None;
    }
    let first = text[at..].chars().next()?;
    let before = text[..at].chars().next_back();
    if !scheme_letter(first)
        || before
            .is_some_and(|c| c.is_alphabetic() || c.is_numeric() || matches!(c, '+' | '.' | '-'))
    {
        return None;
    }
    let colon = run(text, at + first.len_utf8(), |c| {
        scheme_letter(c) || c.is_ascii_digit() || matches!(c, '+' | '.' | '-')
    });
    if !text[colon..].starts_with("://") {
        return None;
    }
    Some(run(text, colon + 3, |c| {
        !is_js_whitespace(c) && !matches!(c, '<' | '>' | '(' | ')')
    }))
}

/// `[a-z]` under the `iu` flags: ASCII letters, and `ſ` and the Kelvin sign, which fold to `s`
/// and `k`.
fn scheme_letter(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '\u{017F}' || c == '\u{212A}'
}

/// The byte index after the longest run of `keep` characters from `from`.
fn run(text: &str, from: usize, keep: impl Fn(char) -> bool) -> usize {
    text[from..]
        .char_indices()
        .find(|(_, c)| {
            step();
            !keep(*c)
        })
        .map_or(text.len(), |(i, _)| from + i)
}

/// Maps ascending byte offsets of `masked` to the same UTF-16 offsets of `original`, in place.
fn to_original(masked: &str, original: &str, offsets: &mut [usize]) {
    let mut masked_chars = masked.char_indices().peekable();
    let mut original_chars = original.char_indices().peekable();
    let (mut masked_units, mut original_units) = (0, 0);
    for offset in offsets.iter_mut() {
        while let Some(&(i, c)) = masked_chars.peek() {
            if i >= *offset {
                break;
            }
            masked_units += c.len_utf16();
            masked_chars.next();
        }
        while let Some(&(_, c)) = original_chars.peek() {
            if original_units >= masked_units {
                break;
            }
            original_units += c.len_utf16();
            original_chars.next();
        }
        *offset = original_chars.peek().map_or(original.len(), |(i, _)| *i);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn snippets_cut_with_an_ellipsis_and_read_white_space_as_spaces() {
        let text = format!("{}\tPlan\n{}", "a".repeat(70), "b".repeat(70));
        let mentions = find_unlinked_mentions(&text, &names(&["Plan"]));
        let context = &mention_contexts(&text, &mentions).contexts[0];
        assert_eq!(
            context.snippet,
            format!("…{} Plan {}…", "a".repeat(59), "b".repeat(59))
        );
        let units: Vec<u16> = context.snippet.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&units[context.link_start..context.link_end]).unwrap(),
            "Plan"
        );
    }
}
