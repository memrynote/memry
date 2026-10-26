//! `Lexer.js`: the token regex, hand-matched over UTF-16 units (JS regexes without `u` work on
//! code units, and every position temml reports is one).

use std::collections::HashMap;
use std::rc::Rc;

use super::settings::Settings;
use super::val::{Loc, R, Tok, perr_at, tok};

pub struct Lexer {
    pub input: Rc<Vec<u16>>,
    pub last_index: usize,
    pub catcodes: HashMap<String, u32>,
    strict: bool,
}

const fn is_space(u: u16) -> bool {
    matches!(u, 0x20 | 0x0D | 0x0A | 0x09)
}

fn is_combining(u: u16) -> bool {
    (0x0300..=0x036F).contains(&u)
}

fn is_single(u: u16) -> bool {
    (0x21..=0x5B).contains(&u)
        || (0x5D..=0x2027).contains(&u)
        || (0x202A..=0xD7FF).contains(&u)
        || u >= 0xF900
}

fn is_letter_at(u: u16) -> bool {
    (0x61..=0x7A).contains(&u) || (0x41..=0x5A).contains(&u) || u == 0x40
}

fn is_ascii_letter(u: u16) -> bool {
    (0x61..=0x7A).contains(&u) || (0x41..=0x5A).contains(&u)
}

fn is_line_terminator(u: u16) -> bool {
    matches!(u, 0x0A | 0x0D | 0x2028 | 0x2029)
}

fn is_high(u: u16) -> bool {
    (0xD800..=0xDBFF).contains(&u)
}

fn is_low(u: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&u)
}

/// What the token regex matched at a position: the end of the match and the token text.
struct Matched {
    end: usize,
    text: Vec<u16>,
}

impl Lexer {
    pub fn new(input: &str, settings: &Settings) -> Lexer {
        let mut catcodes = HashMap::new();
        catcodes.insert("%".to_string(), 14);
        catcodes.insert("~".to_string(), 13);
        Lexer {
            input: Rc::new(input.encode_utf16().collect()),
            last_index: 0,
            catcodes,
            strict: settings.strict,
        }
    }

    pub fn set_catcode(&mut self, ch: &str, code: u32) {
        self.catcodes.insert(ch.to_string(), code);
    }

    fn marks_from(&self, mut i: usize) -> usize {
        while i < self.input.len() && is_combining(self.input[i]) {
            i += 1;
        }
        i
    }

    /// `\verb` + delimiter + `.*?` + delimiter, from `\verb` at `pos`.
    fn verb(&self, pos: usize) -> Option<Matched> {
        let s = &self.input;
        let word: [u16; 5] = [0x5C, 0x76, 0x65, 0x72, 0x62];
        if s.len() < pos + 5 || s[pos..pos + 5] != word {
            return None;
        }
        let mut at = pos + 5;
        let starred = s.get(at) == Some(&0x2A);
        if starred {
            at += 1;
        }
        let delim = *s.get(at)?;
        if !starred && (delim == 0x2A || is_ascii_letter(delim)) {
            return None;
        }
        let mut i = at + 1;
        loop {
            let u = *s.get(i)?;
            if u == delim {
                return Some(Matched {
                    end: i + 1,
                    text: s[pos..i + 1].to_vec(),
                });
            }
            if is_line_terminator(u) {
                return None;
            }
            i += 1;
        }
    }

    fn match_at(&self, pos: usize) -> Option<Matched> {
        let s = &self.input;
        let u = s[pos];
        if is_space(u) {
            let mut i = pos;
            while i < s.len() && is_space(s[i]) {
                i += 1;
            }
            return Some(Matched {
                end: i,
                text: vec![0x20],
            });
        }
        if u == 0x5C {
            // controlSpace: `\` then a newline, or spaces then an optional newline, then blanks.
            if let Some(&n) = s.get(pos + 1) {
                let mut i = None;
                if n == 0x0A {
                    i = Some(pos + 2);
                } else if matches!(n, 0x20 | 0x0D | 0x09) {
                    let mut j = pos + 1;
                    while j < s.len() && matches!(s[j], 0x20 | 0x0D | 0x09) {
                        j += 1;
                    }
                    if s.get(j) == Some(&0x0A) {
                        j += 1;
                    }
                    i = Some(j);
                }
                if let Some(mut j) = i {
                    while j < s.len() && matches!(s[j], 0x20 | 0x0D | 0x09) {
                        j += 1;
                    }
                    return Some(Matched {
                        end: j,
                        text: vec![0x5C, 0x20],
                    });
                }
            }
        }
        if is_single(u) {
            let end = self.marks_from(pos + 1);
            return Some(Matched {
                end,
                text: s[pos..end].to_vec(),
            });
        }
        if is_high(u) && s.get(pos + 1).is_some_and(|n| is_low(*n)) {
            let end = self.marks_from(pos + 2);
            return Some(Matched {
                end,
                text: s[pos..end].to_vec(),
            });
        }
        if u == 0x5C {
            if let Some(m) = self.verb(pos) {
                return Some(m);
            }
            let mut i = pos + 1;
            while i < s.len() && is_letter_at(s[i]) {
                i += 1;
            }
            if i > pos + 1 {
                let word = s[pos..i].to_vec();
                while i < s.len() && is_space(s[i]) {
                    i += 1;
                }
                return Some(Matched { end: i, text: word });
            }
            if let Some(&n) = s.get(pos + 1)
                && !(0xD800..=0xDFFF).contains(&n)
            {
                return Some(Matched {
                    end: pos + 2,
                    text: s[pos..pos + 2].to_vec(),
                });
            }
        }
        None
    }

    pub fn lex(&mut self) -> R<Tok> {
        let pos = self.last_index;
        let len = self.input.len();
        if pos == len {
            return Ok(tok("EOF", Some(self.loc(pos, pos))));
        }
        let Some(m) = self.match_at(pos) else {
            let ch = String::from_utf16_lossy(&self.input[pos..pos + 1]);
            let t = tok(ch.clone(), Some(self.loc(pos, pos + 1)));
            return perr_at(format!("Unexpected character: '{ch}'"), &t);
        };
        self.last_index = m.end;
        let text = String::from_utf16_lossy(&m.text);
        if self.catcodes.get(&text) == Some(&14) {
            let nl = self.input[self.last_index..]
                .iter()
                .position(|u| *u == 0x0A)
                .map(|i| i + self.last_index);
            match nl {
                None => {
                    self.last_index = len;
                    if self.strict {
                        return perr_at(
                            "% comment has no terminating newline; LaTeX would fail because of commenting the end of math mode",
                            &tok("%", None),
                        );
                    }
                }
                Some(i) => self.last_index = i + 1,
            }
            return self.lex();
        }
        Ok(tok(text, Some(self.loc(pos, self.last_index))))
    }

    fn loc(&self, start: usize, end: usize) -> Loc {
        Loc {
            lexer: self.input.clone(),
            start,
            end,
        }
    }
}
