//! The tag rewrite of `sanitizeSvg` and its root check.
//!
//! `TAG_RE` is `/<\/?([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g`. From a given
//! start, its lazy attribute run is deterministic: a quote jumps to its partner, `>` or `/>`
//! ends it, anything else is one step. The greedy name gives back characters until a run
//! starting at its end succeeds (`<a"b "c>` names `a`, its run being `"b "c`). Both facts are
//! tables over the text, filled once, so the rewrite stays linear where the regex is not.

use super::attrs::{local_name, retargets_reference, sanitize_attributes};
use super::scan::{is_ws, prefixed_tag, tick};
use super::strip::FORBIDDEN_ELEMENTS;

const NONE: u32 = u32::MAX;

/// For each index, where an attribute run starting there stops: at the `/` of `/>` or at the
/// `>`. [`NONE`] when the run meets an unpaired quote or the end of the text.
fn run_ends(text: &[char]) -> Vec<u32> {
    let mut ends = vec![NONE; text.len() + 1];
    let (mut next_double, mut next_single): (Option<usize>, Option<usize>) = (None, None);
    for at in (0..text.len()).rev() {
        tick();
        let index = u32::try_from(at).expect("the input is capped below 4 GiB");
        ends[at] = match text[at] {
            '>' => index,
            '/' if text.get(at + 1) == Some(&'>') => index,
            '"' => next_double.map_or(NONE, |partner| ends[partner + 1]),
            '\'' => next_single.map_or(NONE, |partner| ends[partner + 1]),
            _ => ends[at + 1],
        };
        match text[at] {
            '"' => next_double = Some(at),
            '\'' => next_single = Some(at),
            _ => {}
        }
    }
    ends
}

/// For each index, the largest index at or before it where a run succeeds.
fn latest_runs(ends: &[u32]) -> Vec<u32> {
    let mut latest = NONE;
    ends.iter()
        .enumerate()
        .map(|(at, end)| {
            tick();
            if *end != NONE {
                latest = u32::try_from(at).expect("the input is capped below 4 GiB");
            }
            latest
        })
        .collect()
}

/// The end of the `[^\s/>]*` run from `from`. `memo` holds the last run, which every later
/// start inside it shares.
fn name_run_end(text: &[char], from: usize, memo: &mut (usize, usize)) -> usize {
    if memo.0 <= from && from <= memo.1 {
        return memo.1;
    }
    let mut end = from;
    while end < text.len() && !is_ws(text[end]) && text[end] != '/' && text[end] != '>' {
        tick();
        end += 1;
    }
    *memo = (from, end);
    end
}

/// The `TAG_RE` replacement over the whole text.
pub(super) fn rewrite_tags(text: &[char]) -> Vec<char> {
    let ends = run_ends(text);
    let latest = latest_runs(&ends);
    let mut memo = (usize::MAX, 0);
    let mut out = Vec::with_capacity(text.len());
    let (mut copied, mut at) = (0, 0);
    while at < text.len() {
        tick();
        if text[at] != '<' {
            at += 1;
            continue;
        }
        let closing = text.get(at + 1) == Some(&'/');
        let name_start = at + 1 + usize::from(closing);
        if !text.get(name_start).is_some_and(char::is_ascii_alphabetic) {
            at += 1;
            continue;
        }
        let longest = name_run_end(text, name_start + 1, &mut memo);
        let name_end = latest[longest];
        if name_end == NONE || (name_end as usize) <= name_start {
            at += 1;
            continue;
        }
        let name_end = name_end as usize;
        let run_end = ends[name_end] as usize;
        let self_closing = text[run_end] == '/';
        let end = run_end + 1 + usize::from(self_closing);
        out.extend_from_slice(&text[copied..at]);
        let name: String = text[name_start..name_end].iter().collect();
        let attrs = &text[name_end..run_end];
        out.extend(replacement(&name, attrs, closing, self_closing).chars());
        copied = end;
        at = end;
    }
    out.extend_from_slice(&text[copied..]);
    out
}

/// The TypeScript's replacement function for one tag.
fn replacement(name: &str, attrs: &[char], closing: bool, self_closing: bool) -> String {
    let local = local_name(name);
    // Backstop for anything the paired-form pass could not match, and the unwrapped `<a>`.
    if local == "a"
        || FORBIDDEN_ELEMENTS
            .iter()
            .any(|forbidden| forbidden.to_lowercase() == local)
    {
        return String::new();
    }
    if closing {
        return format!("</{name}>");
    }
    if retargets_reference(attrs) {
        return String::new();
    }
    format!(
        "<{name}{}{}>",
        sanitize_attributes(attrs, &local),
        if self_closing { "/" } else { "" }
    )
}

/// `new RegExp('<' + TAG_PREFIX + 'svg[\\s/>]', 'i')`: an `<svg` root survived.
pub(super) fn has_svg_root(text: &[char]) -> bool {
    (0..text.len()).any(|at| {
        tick();
        text[at] == '<'
            && prefixed_tag(text, at + 1, "svg", |t, end| {
                t.get(end)
                    .is_some_and(|c| is_ws(*c) || *c == '/' || *c == '>')
                    .then_some(end)
            })
            .is_some()
    })
}
