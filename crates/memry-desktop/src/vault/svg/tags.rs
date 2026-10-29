//! The tag rewrite of `sanitizeSvg` and its root check.
//!
//! `TAG_RE` is `/<\/?([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g`. From a given
//! start, its lazy attribute run is deterministic: a quote jumps to its partner, `>` or `/>`
//! ends it, anything else is one step. The greedy name gives back characters until a run
//! starting at its end succeeds (`<a"b "c>` names `a`, its run being `"b "c`). Which starts
//! succeed is one bit per byte, filled once from the end. The longest name is a backwards
//! search that a later tag in the same name run reuses, and only the runs of matched tags are
//! walked, so the rewrite stays linear where the regex is not.
//!
//! The rewrite hands its result over piece by piece: the text between tags, and each tag as
//! the TypeScript's replacement function decided it. [`write_typescript`] writes the pieces
//! back as the TypeScript does; `inert` writes them under its own rules.

use super::attrs::{
    Attribute, local_name, retargets_reference, sanitize_attributes, write_attributes,
};
use super::scan::{Finder, as_str, prefixed_tag, tick, ws_len};
use super::strip::FORBIDDEN_ELEMENTS;

/// One piece of the rewritten text.
pub(super) enum Piece<'a> {
    /// Text between two tags, as it stands.
    Text(&'a [u8]),
    /// A tag the TypeScript replaces with nothing.
    Dropped,
    /// A tag the TypeScript writes back.
    Tag(Tag<'a>),
}

pub(super) struct Tag<'a> {
    pub(super) name: &'a str,
    /// [`local_name`] of `name`.
    pub(super) local: String,
    pub(super) closing: bool,
    pub(super) self_closing: bool,
    /// The attribute text between the name and the end; empty for a closer, whose attributes
    /// the TypeScript drops.
    raw: &'a [u8],
}

impl<'a> Tag<'a> {
    /// The attributes the TypeScript keeps.
    pub(super) fn attributes(&self) -> impl Iterator<Item = Attribute<'a>> + use<'a> {
        sanitize_attributes(self.raw, &self.local)
    }
}

/// One bit per index of the text, and one for its end.
struct Bits(Vec<u64>);

impl Bits {
    fn get(&self, at: usize) -> bool {
        self.0[at / 64] >> (at % 64) & 1 == 1
    }
}

/// Whether an attribute run starting at each index succeeds: it reaches `>` or `/>` before an
/// unpaired quote or the end. The end itself never does.
fn successful_runs(text: &[u8]) -> Bits {
    let mut ok = Bits(vec![0; text.len() / 64 + 1]);
    let (mut next_double, mut next_single): (Option<usize>, Option<usize>) = (None, None);
    for at in (0..text.len()).rev() {
        tick();
        let succeeds = match text[at] {
            b'>' => true,
            b'/' if text.get(at + 1) == Some(&b'>') => true,
            b'"' => next_double.is_some_and(|partner| ok.get(partner + 1)),
            b'\'' => next_single.is_some_and(|partner| ok.get(partner + 1)),
            _ => ok.get(at + 1),
        };
        ok.0[at / 64] |= u64::from(succeeds) << (at % 64);
        match text[at] {
            b'"' => next_double = Some(at),
            b'\'' => next_single = Some(at),
            _ => {}
        }
    }
    ok
}

/// The `/` of the `/>` or the `>` where the run from `at`, which succeeds, ends.
fn run_end(text: &[u8], mut at: usize, double: &mut Finder, single: &mut Finder) -> usize {
    loop {
        tick();
        match text[at] {
            b'>' => return at,
            b'/' if text.get(at + 1) == Some(&b'>') => return at,
            b'"' => {
                at = double
                    .next(text, at + 1)
                    .expect("a run that succeeds pairs its quotes")
                    + 1
            }
            b'\'' => {
                at = single
                    .next(text, at + 1)
                    .expect("a run that succeeds pairs its quotes")
                    + 1
            }
            _ => at += 1,
        }
    }
}

/// The end of the `[^\s/>]*` run from `from`. `memo` holds the last run, which every later
/// start inside it shares.
fn name_run_end(text: &[u8], from: usize, memo: &mut (usize, usize)) -> usize {
    if memo.0 <= from && from <= memo.1 {
        return memo.1;
    }
    let mut end = from;
    while end < text.len() && ws_len(text, end) == 0 && text[end] != b'/' && text[end] != b'>' {
        tick();
        end += 1;
    }
    *memo = (from, end);
    end
}

/// The largest success found in `lo..=to`, or `None` when that range has none.
struct Latest {
    to: usize,
    lo: usize,
    found: Option<usize>,
}

/// The largest start in `from..=to` whose run succeeds. Tags tried inside one name run ask
/// with the same `to` and a growing `from`, so the search goes down each stretch once.
fn latest_success(ok: &Bits, from: usize, to: usize, memo: &mut Option<Latest>) -> Option<usize> {
    let (mut found, mut lo) = match memo {
        Some(seen) if seen.to == to => (seen.found, seen.lo),
        _ => (None, to + 1),
    };
    if found.is_none() && from < lo {
        found = (from..lo).rev().find(|&at| {
            tick();
            ok.get(at)
        });
        lo = from;
    }
    *memo = Some(Latest { to, lo, found });
    found.filter(|&at| at >= from)
}

/// The `TAG_RE` replacement over the whole text, handed to `sink` in order.
pub(super) fn rewrite_tags<'a>(text: &'a [u8], mut sink: impl FnMut(Piece<'a>)) {
    let ok = successful_runs(text);
    let (mut double, mut single) = (Finder::new(b'"', text), Finder::new(b'\'', text));
    let mut name_memo = (usize::MAX, 0);
    let mut latest = None;
    let (mut copied, mut at) = (0, 0);
    while at < text.len() {
        tick();
        if text[at] != b'<' {
            at += 1;
            continue;
        }
        let closing = text.get(at + 1) == Some(&b'/');
        let name_start = at + 1 + usize::from(closing);
        if !text.get(name_start).is_some_and(u8::is_ascii_alphabetic) {
            at += 1;
            continue;
        }
        let longest = name_run_end(text, name_start + 1, &mut name_memo);
        let Some(name_end) = latest_success(&ok, name_start + 1, longest, &mut latest) else {
            at += 1;
            continue;
        };
        let run_end = run_end(text, name_end, &mut double, &mut single);
        let self_closing = text[run_end] == b'/';
        if copied < at {
            sink(Piece::Text(&text[copied..at]));
        }
        let name = as_str(&text[name_start..name_end]);
        sink(replacement(
            name,
            &text[name_end..run_end],
            closing,
            self_closing,
        ));
        copied = run_end + 1 + usize::from(self_closing);
        at = copied;
    }
    if copied < text.len() {
        sink(Piece::Text(&text[copied..]));
    }
}

/// The TypeScript's replacement function for one tag.
fn replacement<'a>(name: &'a str, raw: &'a [u8], closing: bool, self_closing: bool) -> Piece<'a> {
    let local = local_name(name);
    // Backstop for anything the paired-form pass could not match, and the unwrapped `<a>`.
    if local == "a"
        || FORBIDDEN_ELEMENTS
            .iter()
            .any(|forbidden| forbidden.to_lowercase() == local)
    {
        return Piece::Dropped;
    }
    if closing {
        return Piece::Tag(Tag {
            name,
            local,
            closing,
            self_closing: false,
            raw: &[],
        });
    }
    if retargets_reference(raw) {
        return Piece::Dropped;
    }
    Piece::Tag(Tag {
        name,
        local,
        closing,
        self_closing,
        raw,
    })
}

/// A piece as the TypeScript writes it.
pub(super) fn write_typescript(out: &mut Vec<u8>, piece: Piece<'_>) {
    match piece {
        Piece::Text(text) => out.extend_from_slice(text),
        Piece::Dropped => {}
        Piece::Tag(tag) => {
            out.extend_from_slice(if tag.closing { b"</" } else { b"<" });
            out.extend_from_slice(tag.name.as_bytes());
            write_attributes(out, tag.attributes());
            out.extend_from_slice(if tag.self_closing { b"/>" } else { b">" });
        }
    }
}

/// `new RegExp('<' + TAG_PREFIX + 'svg[\\s/>]', 'i')`: an `<svg` root survived.
pub(super) fn has_svg_root(text: &[u8]) -> bool {
    (0..text.len()).any(|at| {
        tick();
        text[at] == b'<'
            && prefixed_tag(text, at + 1, "svg", |t, end| {
                (ws_len(t, end) > 0 || matches!(t.get(end), Some(b'/' | b'>'))).then_some(end)
            })
            .is_some()
    })
}
