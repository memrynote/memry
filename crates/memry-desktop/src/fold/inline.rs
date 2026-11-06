//! Inline Markdown that survives folding (`engine-inline.ts`, and `stripInline` of
//! `engine.ts`). The plain text the hashes and sentences use comes out of the same steps run
//! over a position-tracked string, so every plain sentence maps back to its Markdown source
//! (bold, italic, code, links, wiki-links).

use std::sync::LazyLock;

use crate::web::extract::utils::js::is_js_whitespace;
use regex::{Captures, Regex};

use super::text::step;

/// The text, and for each of its bytes the byte in the original Markdown it came from.
struct Tracked {
    text: String,
    pos: Vec<usize>,
}

impl Tracked {
    fn new(md: &str) -> Self {
        Self {
            text: md.to_owned(),
            pos: (0..md.len()).collect(),
        }
    }

    fn copy(&self, from: usize, to: usize, into: &mut Tracked) {
        into.text.push_str(&self.text[from..to]);
        into.pos.extend_from_slice(&self.pos[from..to]);
    }
}

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("fold inline pattern")
}

static IMAGE: LazyLock<Regex> = LazyLock::new(|| regex(r"!\[[^\]]*\]\([^)]*\)"));
static WIKI_LINK: LazyLock<Regex> = LazyLock::new(|| regex(r"\[\[([^\]|]*\|)?([^\]]*)\]\]"));
static LINK: LazyLock<Regex> = LazyLock::new(|| regex(r"\[([^\]]*)\]\([^)]*\)"));
static MARKS: LazyLock<Regex> = LazyLock::new(|| regex(r"(\*\*|__|~~|`)"));
static TAG: LazyLock<Regex> = LazyLock::new(|| regex(r"<[^>]+>"));
static WIDE_SPACE: LazyLock<Regex> = LazyLock::new(|| regex(r"[ \t]{2,}"));

/// One `replace` of the chain: every match is replaced by the capture groups in `keep`.
fn apply(t: &Tracked, re: &Regex, keep: &[usize]) -> Tracked {
    let mut out = Tracked {
        text: String::with_capacity(t.text.len()),
        pos: Vec::with_capacity(t.pos.len()),
    };
    let mut last = 0;
    for caps in re.captures_iter(&t.text) {
        let whole = caps.get(0).expect("match");
        t.copy(last, whole.start(), &mut out);
        keep_groups(t, &caps, keep, &mut out);
        last = whole.end();
    }
    t.copy(last, t.text.len(), &mut out);
    out
}

fn keep_groups(t: &Tracked, caps: &Captures<'_>, keep: &[usize], out: &mut Tracked) {
    for &group in keep {
        if let Some(m) = caps.get(group) {
            t.copy(m.start(), m.end(), out);
        }
    }
}

/// `/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g`, keeping groups 1 and 2. The `regex` crate
/// has no lookahead; the run can only close at the first `*` or `_` after it, so each start
/// has at most one candidate and the lookahead is a check of the next character.
fn apply_emphasis(t: &Tracked) -> Tracked {
    let text = &t.text;
    let mut out = Tracked {
        text: String::with_capacity(text.len()),
        pos: Vec::with_capacity(t.pos.len()),
    };
    let is_mark = |c: char| c == '*' || c == '_';
    let mut last = 0;
    let mut at = 0;
    while at < text.len() {
        let found = emphasis_at(text, at, is_mark);
        match found {
            Some((lead, content, end)) => {
                t.copy(last, at, &mut out);
                t.copy(at, lead, &mut out);
                t.copy(content.0, content.1, &mut out);
                last = end;
                at = end;
            }
            None => at += text[at..].chars().next().map_or(1, char::len_utf8),
        }
    }
    t.copy(last, text.len(), &mut out);
    out
}

/// A match starting at `at`: (end of group 1, group 2's range, end of the match).
fn emphasis_at(
    text: &str,
    at: usize,
    is_mark: impl Fn(char) -> bool,
) -> Option<(usize, (usize, usize), usize)> {
    step(1);
    let first = text[at..].chars().next()?;
    // `^` is tried before `\s`; `^` only matches at the start of the text.
    let lead = if at == 0 && is_mark(first) {
        at
    } else if is_js_whitespace(first) {
        at + first.len_utf8()
    } else {
        return None;
    };
    let mut chars = text[lead..].char_indices();
    let (_, open) = chars.next()?;
    if !is_mark(open) {
        return None;
    }
    let start = lead + open.len_utf8();
    let mut end = start;
    for (i, c) in text[start..].char_indices() {
        step(1);
        if is_mark(c) || c == '\n' {
            end = start + i;
            break;
        }
        end = start + i + c.len_utf8();
    }
    let close = text[end..].chars().next()?;
    if end == start || !is_mark(close) {
        return None;
    }
    let after = end + close.len_utf8();
    let ahead_ok = match text[after..].chars().next() {
        None => true,
        Some(c) => is_js_whitespace(c) || ".,;:!?".contains(c),
    };
    ahead_ok.then_some((lead, (start, end), after))
}

/// `\s+` to one space, then `trim` (collapseWhitespace).
fn collapse_whitespace(t: &Tracked) -> Tracked {
    let mut out = Tracked {
        text: String::with_capacity(t.text.len()),
        pos: Vec::with_capacity(t.pos.len()),
    };
    for (i, c) in t.text.char_indices() {
        if is_js_whitespace(c) {
            if !out.text.is_empty() && !out.text.ends_with(' ') {
                // The space stands for the whole character: a cut after it lands past its
                // last byte, as a JavaScript cut lands past its one code unit.
                out.text.push(' ');
                out.pos.push(t.pos[i + c.len_utf8() - 1]);
            }
        } else {
            t.copy(i, i + c.len_utf8(), &mut out);
        }
    }
    if out.text.ends_with(' ') {
        out.text.pop();
        out.pos.pop();
    }
    out
}

fn track_inline(md: &str) -> Tracked {
    let mut t = Tracked::new(md);
    t = apply(&t, &IMAGE, &[]);
    t = apply(&t, &WIKI_LINK, &[2]);
    t = apply(&t, &LINK, &[1]);
    t = apply(&t, &MARKS, &[]);
    t = apply_emphasis(&t);
    t = apply(&t, &TAG, &[]);
    collapse_whitespace(&t)
}

/// The plain text of a line of Markdown: what is hashed, split into sentences and counted.
pub fn strip_inline(line: &str) -> String {
    track_inline(line).text
}

fn escape_plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '~' | '[' | ']' | '<') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A sentence cut out of a longer span can hold half a pair; close it, or give up.
fn balance(md: &str) -> Option<String> {
    let mut s = md.trim_matches(is_js_whitespace).to_owned();
    for d in ["**", "__", "~~", "`"] {
        if s.matches(d).count() % 2 == 0 {
            continue;
        }
        if s.starts_with(d) {
            s.push_str(d);
        } else if s.ends_with(d) {
            s.insert_str(0, d);
        } else {
            return None;
        }
    }
    let single = s.replace("**", "").replace("__", "").replace("~~", "");
    for d in ["*", "_"] {
        if single.matches(d).count() % 2 == 0 {
            continue;
        }
        if single.starts_with(d) {
            s.push_str(d);
        } else if single.ends_with(d) {
            s.insert_str(0, d);
        } else {
            return None;
        }
    }
    (s.matches('[').count() == s.matches(']').count()).then_some(s)
}

/// Inline Markdown per plain sentence, aligned 1:1 with `sentences`. `plain` is
/// `strip_inline(md)`; when the tracked text disagrees with it, or a sentence cannot be cut
/// cleanly, that sentence falls back to escaped plain text.
pub fn sentences_to_markdown(md: &str, plain: &str, sentences: &[String]) -> Vec<String> {
    let fallback = || sentences.iter().map(|s| escape_plain(s)).collect();
    let clean = IMAGE.replace_all(md, "");
    let clean = TAG.replace_all(&clean, "");
    let clean = WIDE_SPACE.replace_all(&clean, " ").into_owned();
    let tracked = track_inline(&clean);
    if tracked.text != plain {
        return fallback();
    }
    let mut starts = Vec::with_capacity(sentences.len());
    let mut cursor = 0;
    for s in sentences {
        let Some(at) = plain[cursor..].find(s.as_str()).map(|i| cursor + i) else {
            return fallback();
        };
        step(at - cursor + s.len());
        starts.push(at);
        cursor = at + s.len();
    }
    let cuts: Vec<usize> = starts
        .iter()
        .map(|&a| if a == 0 { 0 } else { tracked.pos[a - 1] + 1 })
        .collect();
    sentences
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let end = cuts.get(i + 1).copied().unwrap_or(clean.len());
            balance(&clean[cuts[i]..end]).unwrap_or_else(|| escape_plain(s))
        })
        .collect()
}
