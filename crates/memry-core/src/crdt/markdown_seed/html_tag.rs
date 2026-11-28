//! The constructs `tryInlineHtml` (BlockNote's `markdownToHtml.ts`) reads at a
//! `<`: a tag, a CDATA section, a processing instruction or a declaration,
//! with only space and tab as whitespace, on one line and within [`BOUND`]
//! UTF-16 units. No step of the read can be taken back, and the searches that
//! could run to the line's end are shared ([`Finder`]), so a line of unfinished
//! constructs costs a pass, not one per `<`. See [`super::raw_html`].

/// The longest tag, in UTF-16 units from its `<`, read as one token.
pub(super) const BOUND: usize = 1024;

pub(super) fn is_letter(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphabetic())
}

pub(super) fn is_name_char(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub(super) fn is_blank(c: Option<char>) -> bool {
    matches!(c, Some(' ' | '\t'))
}

fn is_attr_start(c: Option<char>) -> bool {
    is_letter(c) || matches!(c, Some('_' | ':'))
}

fn is_attr_char(c: Option<char>) -> bool {
    is_name_char(c) || matches!(c, Some('_' | ':' | '.'))
}

fn is_unquoted(c: char) -> bool {
    !is_blank(Some(c)) && !"\"'=<>`".contains(c)
}

pub(super) struct Tag {
    pub(super) name: String,
    pub(super) closing: bool,
    pub(super) self_closing: bool,
    /// Lowercased names with their values, quotes off.
    pub(super) attrs: Vec<(String, String)>,
}

pub(super) struct Construct {
    pub(super) end: usize,
    pub(super) tag: Option<Tag>,
}

/// One line as characters, with each character's UTF-16 offset.
pub(super) struct Line<'a> {
    pub(super) c: &'a [char],
    units: Vec<usize>,
}

impl<'a> Line<'a> {
    pub(super) fn new(c: &'a [char]) -> Self {
        let mut units = Vec::with_capacity(c.len() + 1);
        let mut at = 0;
        for ch in c {
            units.push(at);
            at += ch.len_utf16();
        }
        units.push(at);
        Self { c, units }
    }

    pub(super) fn get(&self, at: usize) -> Option<char> {
        self.c.get(at).copied()
    }

    /// The last index a tag opening at `at` may end at.
    fn limit(&self, at: usize) -> usize {
        let cap = self.units[at] + BOUND;
        self.units.partition_point(|&unit| unit <= cap) - 1
    }

    /// Where `needle` starts at or after `from`, and ends by `limit`.
    fn index_before(&self, needle: &[char], from: usize, limit: usize) -> Option<usize> {
        (from..=limit.checked_sub(needle.len())?).find(|&at| self.c[at..].starts_with(needle))
    }
}

/// The next place a needle starts, from a position that only moves forward:
/// the last hit stands until the position passes it, and a miss stands for
/// good, so a line of unfinished `<?` costs one search, not one per `<`.
pub(super) struct Finder {
    needle: &'static [char],
    found: Option<Option<usize>>,
}

impl Finder {
    fn new(needle: &'static [char]) -> Self {
        Self {
            needle,
            found: None,
        }
    }

    fn next(&mut self, c: &[char], from: usize) -> Option<usize> {
        match self.found {
            Some(None) => return None,
            Some(Some(at)) if at >= from => return Some(at),
            _ => {}
        }
        let found = (from..c.len()).find(|&at| c[at..].starts_with(self.needle));
        self.found = Some(found);
        found
    }
}

pub(super) struct Closers {
    cdata: Finder,
    instruction: Finder,
    declaration: Finder,
}

impl Closers {
    pub(super) fn new() -> Self {
        Self {
            cdata: Finder::new(&[']', ']', '>']),
            instruction: Finder::new(&['?', '>']),
            declaration: Finder::new(&['>']),
        }
    }
}

/// A tag as `INLINE_HTML_TAG_RE` reads one, with only space and tab as
/// whitespace and every search stopped at `limit`. No step can be taken back,
/// so the read is linear.
fn read_tag(line: &Line, at: usize, limit: usize) -> Option<Construct> {
    let mut p = at + 1;
    let closing = line.get(p) == Some('/');
    if closing {
        p += 1;
    }
    if !is_letter(line.get(p)) {
        return None;
    }
    let name_start = p;
    while p < limit && is_name_char(line.get(p)) {
        p += 1;
    }
    let name: String = line.c[name_start..p]
        .iter()
        .collect::<String>()
        .to_ascii_lowercase();
    let mut attrs: Vec<(String, String)> = Vec::new();
    loop {
        let gap = p;
        while p < limit && is_blank(line.get(p)) {
            p += 1;
        }
        let spaced = p > gap;
        if p < limit && line.get(p) == Some('>') {
            return Some(Construct {
                end: p + 1,
                tag: Some(Tag {
                    name,
                    closing,
                    self_closing: false,
                    attrs,
                }),
            });
        }
        if p + 1 < limit && line.get(p) == Some('/') && line.get(p + 1) == Some('>') {
            return Some(Construct {
                end: p + 2,
                tag: Some(Tag {
                    name,
                    closing,
                    self_closing: true,
                    attrs,
                }),
            });
        }
        if !spaced || p >= limit || !is_attr_start(line.get(p)) {
            return None;
        }
        let attr_start = p;
        while p < limit && is_attr_char(line.get(p)) {
            p += 1;
        }
        let attr: String = line.c[attr_start..p]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        let mut q = p;
        while q < limit && is_blank(line.get(q)) {
            q += 1;
        }
        if q >= limit || line.get(q) != Some('=') {
            attrs.push((attr, String::new()));
            continue;
        }
        q += 1;
        while q < limit && is_blank(line.get(q)) {
            q += 1;
        }
        if q >= limit {
            return None;
        }
        let quote = line.c[q];
        if quote == '"' || quote == '\'' {
            let close = line.index_before(&[quote], q + 1, limit)?;
            attrs.push((attr, line.c[q + 1..close].iter().collect()));
            p = close + 1;
        } else {
            let value_start = q;
            while q < limit && is_unquoted(line.c[q]) {
                q += 1;
            }
            if q == value_start {
                return None;
            }
            attrs.push((attr, line.c[value_start..q].iter().collect()));
            p = q;
        }
    }
}

/// The construct `tryInlineHtml` reads at the `<` at `at`, on this line only.
pub(super) fn read_construct(line: &Line, at: usize, closers: &mut Closers) -> Option<Construct> {
    const CDATA: [char; 9] = ['<', '!', '[', 'C', 'D', 'A', 'T', 'A', '['];
    let limit = line.limit(at);
    match line.get(at + 1) {
        Some('!') => {
            if line.c[at..].starts_with(&CDATA) {
                let close = closers.cdata.next(line.c, at + 9)?;
                return (close + 3 <= limit).then_some(Construct {
                    end: close + 3,
                    tag: None,
                });
            }
            if !is_letter(line.get(at + 2)) {
                return None;
            }
            let close = closers.declaration.next(line.c, at + 3)?;
            (close < limit).then_some(Construct {
                end: close + 1,
                tag: None,
            })
        }
        Some('?') => {
            let close = closers.instruction.next(line.c, at + 2)?;
            (close + 2 <= limit).then_some(Construct {
                end: close + 2,
                tag: None,
            })
        }
        _ => read_tag(line, at, limit),
    }
}

/// `<` that could open a tag, a closing tag, a declaration or a processing
/// instruction. A `<!--` comment has its own masks.
pub(super) fn opens_construct(line: &Line, at: usize) -> bool {
    match line.get(at + 1) {
        Some('/') => is_letter(line.get(at + 2)),
        Some('!') => !(line.get(at + 2) == Some('-') && line.get(at + 3) == Some('-')),
        Some('?') => true,
        next => is_letter(next),
    }
}
