//! The single-pass CriticMarkup scanner (`iterateCriticMarkupMatches`). Each
//! closing delimiter is searched forward only, and once it is known to be
//! absent from the rest of the text it is never searched again, so the scan is
//! O(n). Offsets here are byte offsets; every delimiter is ASCII, so a match
//! always starts and ends on a character boundary.

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Delimited<'a> {
    /// `{==C1==}{>>C2<<}`
    HighlightedComment { visible: &'a str, payload: &'a str },
    /// `{++C++}`
    Addition(&'a str),
    /// `{--C--}`
    Deletion(&'a str),
    /// `{~~C1~>C2~~}`
    Substitution { original: &'a str, visible: &'a str },
    /// `{>>C<<}`
    Comment(&'a str),
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct CriticMatch<'a> {
    pub index: usize,
    pub end: usize,
    pub kind: Delimited<'a>,
}

#[derive(Clone, Copy)]
enum Closer {
    Highlight,
    CommentClose,
    Addition,
    Deletion,
    SubstArrow,
    SubstClose,
}

impl Closer {
    fn text(self) -> &'static str {
        match self {
            Self::Highlight => "==}",
            Self::CommentClose => "<<}",
            Self::Addition => "++}",
            Self::Deletion => "--}",
            Self::SubstArrow => "~>",
            Self::SubstClose => "~~}",
        }
    }
}

struct Scanner<'a> {
    text: &'a str,
    exhausted: [bool; 6],
}

impl<'a> Scanner<'a> {
    fn find_close(&mut self, closer: Closer, from: usize) -> Option<usize> {
        if self.exhausted[closer as usize] {
            return None;
        }
        let found = self
            .text
            .get(from..)
            .and_then(|rest| rest.find(closer.text()))
            .map(|offset| from + offset);
        if found.is_none() {
            self.exhausted[closer as usize] = true;
        }
        found
    }

    fn match_at(&mut self, i: usize) -> Option<CriticMatch<'a>> {
        let text = self.text;
        let rest = &text[i..];
        if rest.starts_with("{==") {
            let c1 = self.find_close(Closer::Highlight, i + 3)?;
            let after = c1 + 3;
            if !text[after..].starts_with("{>>") {
                return None;
            }
            let c2 = self.find_close(Closer::CommentClose, after + 3)?;
            return Some(CriticMatch {
                index: i,
                end: c2 + 3,
                kind: Delimited::HighlightedComment {
                    visible: &text[i + 3..c1],
                    payload: &text[after + 3..c2],
                },
            });
        }
        if rest.starts_with("{++") {
            let c = self.find_close(Closer::Addition, i + 3)?;
            return Some(CriticMatch {
                index: i,
                end: c + 3,
                kind: Delimited::Addition(&text[i + 3..c]),
            });
        }
        if rest.starts_with("{--") {
            let c = self.find_close(Closer::Deletion, i + 3)?;
            return Some(CriticMatch {
                index: i,
                end: c + 3,
                kind: Delimited::Deletion(&text[i + 3..c]),
            });
        }
        if rest.starts_with("{~~") {
            let arrow = self.find_close(Closer::SubstArrow, i + 3)?;
            let close = self.find_close(Closer::SubstClose, arrow + 2)?;
            return Some(CriticMatch {
                index: i,
                end: close + 3,
                kind: Delimited::Substitution {
                    original: &text[i + 3..arrow],
                    visible: &text[arrow + 2..close],
                },
            });
        }
        if rest.starts_with("{>>") {
            let c = self.find_close(Closer::CommentClose, i + 3)?;
            return Some(CriticMatch {
                index: i,
                end: c + 3,
                kind: Delimited::Comment(&text[i + 3..c]),
            });
        }
        None
    }
}

pub(super) fn critic_markup_matches(markdown: &str) -> Vec<CriticMatch<'_>> {
    let mut scanner = Scanner {
        text: markdown,
        exhausted: [false; 6],
    };
    let bytes = markdown.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{'
            && let Some(found) = scanner.match_at(i)
        {
            i = found.end;
            out.push(found);
            continue;
        }
        i += 1;
    }
    out
}
