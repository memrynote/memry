//! Desktop's emphasis writer for a callout or quote body's paragraph:
//! `packages/editor-schema/src/inline/emphasis-runs.ts`
//! (`restoreEmphasisRuns`, `spellRuns`, `spellsRunsWithUnderscores`). A run's
//! leading and trailing whitespace and breaks stay outside its delimiters
//! (`EDGES`), and a run the parser would misread with stars is spelled with
//! underscores where the parser reads those.
//!
//! The core holds flat items, one mark each, so a run never has a run inside
//! it: no `lastRun` of its own to meet.

use crate::domain::journal_rules::is_js_whitespace;

use super::items::Item;
use super::roundtrip::BREAK;

/// Where an underscore pair may stand for one run's stars: the byte offsets
/// of its opening and closing delimiter, which are as long as each other.
struct Delimiters {
    open: usize,
    close: usize,
    len: usize,
}

/// One paragraph's or heading's markdown, as the runs are written into it.
#[derive(Default)]
pub(super) struct RunWriter {
    pub(super) out: String,
    pairs: Vec<Delimiters>,
    /// `lastRun` and `runEnd`: where `out` stood right after the last run
    /// written, and whether its spelling ends in a star.
    last_run: Option<(usize, bool)>,
}

impl RunWriter {
    /// `restoreEmphasisRuns`: a mark's run, `run` spelled with `delimiter`
    /// unless its edges say otherwise.
    pub(super) fn emphasis(&mut self, run: &str, delimiter: &str) {
        let lead = edge_prefix(run, 0, false);
        let trail = run[lead..]
            .char_indices()
            .map(|(at, _)| lead + at)
            .chain([run.len()])
            .find(|&at| edge_prefix(run, at, true) == run.len() - at)
            .unwrap_or(run.len());
        if lead >= trail {
            self.out.push_str(run);
            return;
        }
        let content = &run[lead..trail];
        // Stars against the stars of the run before (`*a***b**`) open bold
        // italic too.
        let touches = lead == 0
            && delimiter.starts_with('*')
            && self
                .last_run
                .is_some_and(|(end, star)| end == self.out.len() && star);
        let candidate =
            (meets_inner_stars(delimiter, content) || touches) && !has_bare_underscore(content);
        self.out.push_str(&run[..lead]);
        let open = self.out.len();
        self.out.push_str(delimiter);
        self.out.push_str(content);
        let close = self.out.len();
        self.out.push_str(delimiter);
        self.last_run = Some((self.out.len(), !candidate && delimiter.ends_with('*')));
        self.out.push_str(&run[trail..]);
        if candidate {
            self.pairs.push(Delimiters {
                open,
                close,
                len: delimiter.len(),
            });
        }
    }

    /// Whether a run is an underscore candidate, which `spellsRunsWithUnderscores`
    /// asks of the escaped block.
    pub(super) fn has_candidate(&self) -> bool {
        !self.pairs.is_empty()
    }

    /// `resolveUnderscores`: each candidate pair spelled `_` or `__` where
    /// the parser reads them (`tryItalic` and `tryBold` refuse an opener
    /// between two word characters, and no run closes on an underscore next
    /// to another), and with its stars where it would not. Each is judged on
    /// the text before any pair changes, in which a pair's delimiters are the
    /// words the writer's tokens are.
    pub(super) fn finish(self) -> String {
        let Self { mut out, pairs, .. } = self;
        let view = TokenView::new(&out, &pairs);
        let readable: Vec<&Delimiters> = pairs
            .iter()
            .enumerate()
            .filter(|(n, _)| view.reads_as_underscores(*n))
            .map(|(_, pair)| pair)
            .collect();
        for pair in readable {
            let swap = "_".repeat(pair.len);
            out.replace_range(pair.open..pair.open + pair.len, &swap);
            out.replace_range(pair.close..pair.close + pair.len, &swap);
        }
        out
    }
}

/// `spellsRunsWithUnderscores`: whether house style spells a run of the
/// escaped `items` with underscores once every bare `_` in their text is
/// escaped too.
pub(super) fn spells_runs_with_underscores(items: &[Item]) -> bool {
    let mut writer = RunWriter::default();
    for item in items {
        let marks = &item.marks;
        let text = escape_underscores(&item.text);
        if let Some(href) = &marks.link {
            writer.out.push_str(&format!("[{text}]({href})"));
        } else if marks.code {
            writer.out.push_str(&format!("`{}`", item.text));
        } else if let Some(delimiter) = delimiter(item) {
            writer.emphasis(&text, delimiter);
        } else {
            writer.out.push_str(&text);
        }
    }
    writer.has_candidate()
}

/// An item's mark delimiter.
pub(super) fn delimiter(item: &Item) -> Option<&'static str> {
    let marks = &item.marks;
    if marks.bold {
        Some("**")
    } else if marks.italic {
        Some("*")
    } else if marks.strike {
        Some("~~")
    } else {
        None
    }
}

/// `text.replace(/\\[\s\S]|_/g, …)`: each bare `_` escaped, an escape pair
/// as it is.
fn escape_underscores(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                out.push(c);
                out.extend(chars.next());
            }
            '_' => out.push_str("\\_"),
            _ => out.push(c),
        }
    }
    out
}

/// `meetsInnerStars`, for a run with no run inside it: three stars in a row
/// open bold italic, so an italic run whose content starts or ends with `*`
/// and a bold run whose content ends with one came back as text. A star the
/// escaper escaped (`*a\**`) meets no delimiter.
fn meets_inner_stars(delimiter: &str, content: &str) -> bool {
    let ends_in_star = content
        .strip_suffix('*')
        .is_some_and(|rest| rest.chars().rev().take_while(|c| *c == '\\').count() % 2 == 0);
    match delimiter {
        "*" => content.starts_with('*') || ends_in_star,
        "**" => ends_in_star,
        _ => false,
    }
}

/// `hasBareUnderscore`: `parseDelimited` skips an escaped character, so only a
/// bare `_` could close an underscore run early.
fn has_bare_underscore(content: &str) -> bool {
    let mut chars = content.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            chars.next();
        } else if c == '_' {
            return true;
        }
    }
    false
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The paragraph as `resolveUnderscores` sees it: each candidate pair's
/// delimiters replaced by the token the writer put there, a word that starts
/// with a letter and ends with `;`.
struct TokenView {
    chars: Vec<char>,
    /// Per pair, where its opening and closing token start, and the tokens' length.
    spans: Vec<(usize, usize, usize)>,
}

impl TokenView {
    fn new(out: &str, pairs: &[Delimiters]) -> Self {
        let mut chars = Vec::new();
        let mut spans = Vec::new();
        let mut from = 0;
        for (n, pair) in pairs.iter().enumerate() {
            let token: Vec<char> = format!("MEMRYEMU{n};").chars().collect();
            chars.extend(out[from..pair.open].chars());
            let open = chars.len();
            chars.extend(&token);
            chars.extend(out[pair.open + pair.len..pair.close].chars());
            let close = chars.len();
            chars.extend(&token);
            from = pair.close + pair.len;
            spans.push((open, close, token.len()));
        }
        chars.extend(out[from..].chars());
        Self { chars, spans }
    }

    fn at(&self, index: usize) -> Option<char> {
        self.chars.get(index).copied()
    }

    /// Whether pair `n` is spelled with underscores.
    fn reads_as_underscores(&self, n: usize) -> bool {
        let (open, close, token) = self.spans[n];
        let before = open.checked_sub(1).and_then(|i| self.at(i));
        let opens = !(is_word(before) && is_word(self.at(open + token))) && before != Some('_');
        opens && self.at(close + token) != Some('_') && !self.underscore_opens_before(open)
    }

    /// `underscoreOpensBefore`: whether a bare `_` before `at` in its
    /// paragraph could open a run, which would close on an underscore
    /// delimiter at `at`. The escaper escapes those in text, so this finds one
    /// in a code span or an address.
    fn underscore_opens_before(&self, at: usize) -> bool {
        // The paragraph starts after the last `/\n[ \t>]*\n/` match.
        let mut start = 0;
        let mut i = 0;
        while i < at {
            if self.chars[i] == '\n' {
                let mut k = i + 1;
                while k < at && matches!(self.chars[k], ' ' | '\t' | '>') {
                    k += 1;
                }
                if k < at && self.chars[k] == '\n' {
                    start = k + 1;
                    i = k + 1;
                    continue;
                }
            }
            i += 1;
        }
        let mut i = start;
        while i < at {
            if self.chars[i] == '\\' {
                i += 1;
            } else if self.chars[i] == '_'
                && !(is_word(i.checked_sub(1).and_then(|p| self.at(p))) && is_word(self.at(i + 1)))
            {
                return true;
            }
            i += 1;
        }
        false
    }
}

/// `isBackslashEscaped`: whether an odd run of backslashes stands before `at`.
fn is_backslash_escaped(text: &str, at: usize) -> bool {
    text[..at].bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 1
}

/// The length of the longest prefix of `text` matching
/// `/(?:\\\n(?:[^\S\n]*>)*|\s)*/`: a break (with the `>` prefixes a quote
/// carries onto the next line) or whitespace. At a run's end (`trailing`) a
/// `<br>` is one too, unless a backslash escapes it (`\<br>` is the text): the
/// break the escaper spelled for a heading's line. `text` is `run` from `from`.
fn edge_prefix(run: &str, from: usize, trailing: bool) -> usize {
    let text = &run[from..];
    let mut at = 0;
    loop {
        let rest = &text[at..];
        if rest.starts_with(BREAK) {
            at += BREAK.len();
            // `(?:[^\S\n]*>)*`
            loop {
                let tail = &text[at..];
                let blanks = tail
                    .find(|c: char| c == '\n' || !is_js_whitespace(c))
                    .unwrap_or(tail.len());
                if tail[blanks..].starts_with('>') {
                    at += blanks + 1;
                } else {
                    break;
                }
            }
        } else if trailing && rest.starts_with("<br>") && !is_backslash_escaped(run, from + at) {
            at += "<br>".len();
        } else if let Some(c) = rest.chars().next().filter(|c| is_js_whitespace(*c)) {
            at += c.len_utf8();
        } else {
            return at;
        }
    }
}
