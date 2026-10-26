//! `Parser.js`: the symbol half of `parseGroup`: ligatures and `parseSymbol`.

use super::functions;
use super::parser::Parser;
use super::tables::{symbol, tables};
use super::val::{R, V, loc_range, perr, perr_at};
use crate::node;

const BIN_LEFT_CANCELLERS: [&str; 5] = ["bin", "op", "open", "punct", "rel"];

/// The trailing run of U+0300..U+036F in `text`, as `[start, end)` UTF-16 offsets.
fn combining_tail(text: &str) -> Option<usize> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut i = units.len();
    while i > 0 && (0x0300..=0x036F).contains(&units[i - 1]) {
        i -= 1;
    }
    (i < units.len()).then_some(i)
}

fn utf16_prefix_str(text: &str, n: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(n).collect::<Vec<_>>())
}

fn utf16_suffix_str(text: &str, n: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().skip(n).collect::<Vec<_>>())
}

/// `text[0]` when it is a whole BMP character (a lone surrogate matches no table key).
fn first_bmp(text: &str) -> Option<char> {
    text.chars().next().filter(|c| (*c as u32) < 0x10000)
}

fn is_verb(text: &str) -> bool {
    match text.strip_prefix("\\verb") {
        Some(rest) => rest
            .chars()
            .next()
            .is_some_and(|c| !c.is_ascii_alphabetic()),
        None => false,
    }
}

impl Parser {
    pub(super) fn form_ligatures(&self, group: &mut Vec<V>) {
        if group.is_empty() {
            return;
        }
        let mut n = group.len() as isize - 1;
        let mut i = 0isize;
        while i < n {
            let a = group[i as usize].clone();
            let v = a.get("text");
            let next_text = group[i as usize + 1].get("text");
            let is = |x: &V, s: &str| matches!(x, V::Str(t) if t == s);
            if is(&v, "-") && is(&next_text, "-") {
                if i + 1 < n && is(&group[i as usize + 2].get("text"), "-") {
                    let t = node! {"type" => "textord", "mode" => "text", "text" => "---"};
                    group.splice(i as usize..i as usize + 3, [t]);
                    n -= 2;
                } else {
                    let t = node! {"type" => "textord", "mode" => "text", "text" => "--"};
                    group.splice(i as usize..i as usize + 2, [t]);
                    n -= 1;
                }
            }
            let v = group[i as usize].get("text");
            let is_quote = matches!(&v, V::Str(t) if t == "'" || t == "`");
            if is_quote && i + 1 < group.len() as isize {
                let doubled = group[i as usize + 1].get("text");
                let (V::Str(a), V::Str(b)) = (&v, &doubled) else {
                    i += 1;
                    continue;
                };
                if a == b {
                    let t =
                        node! {"type" => "textord", "mode" => "text", "text" => format!("{a}{a}")};
                    group.splice(i as usize..i as usize + 2, [t]);
                    n -= 1;
                }
            }
            i += 1;
        }
    }

    pub(super) fn parse_symbol(&mut self) -> R<Option<V>> {
        let nucleus = self.fetch()?;
        let mut text = nucleus.borrow().text.clone();
        if is_verb(&text) {
            self.consume();
            let mut arg = utf16_suffix_str(&text, 5);
            let star = arg.starts_with('*');
            if star {
                arg = utf16_suffix_str(&arg, 1);
            }
            let chars: Vec<char> = arg.chars().collect();
            if chars.len() < 2 || chars[0] != chars[chars.len() - 1] {
                return perr(
                    "\\verb assertion failed --\n                    please report what input caused this bug",
                );
            }
            let inner: String = chars[1..chars.len() - 1].iter().collect();
            return Ok(Some(
                node! {"type" => "verb", "mode" => "text", "body" => inner, "star" => star},
            ));
        }
        let mode = self.mode;
        if let Some(first) = first_bmp(&text)
            && let Some(replacement) = tables().unicode_symbols.get(&first.to_string())
            && mode == "math"
            && symbol(mode, &first.to_string()).is_none()
        {
            if self.settings.strict {
                return perr_at(
                    format!("Accented Unicode text character \"{first}\" used in math mode"),
                    &nucleus,
                );
            }
            text = format!("{replacement}{}", utf16_suffix_str(&text, 1));
        }
        let combining = if mode == "math" {
            combining_tail(&text)
        } else {
            None
        };
        let match_text = combining.map(|at| utf16_suffix_str(&text, at));
        if let Some(at) = combining {
            text = utf16_prefix_str(&text, at);
            if text == "i" {
                text = "\u{131}".to_string();
            } else if text == "j" {
                text = "\u{237}".to_string();
            }
        }
        let mut sym: V;
        if let Some(entry) = symbol(mode, &text) {
            let mut group = entry.group.clone();
            if group == "bin"
                && (BIN_LEFT_CANCELLERS.contains(&self.prev_atom_type.as_str())
                    || self.prev_atom_type.is_empty())
            {
                group = "open".to_string();
            }
            let loc = loc_range(&nucleus, None);
            let s;
            if tables().atoms.contains(&group) {
                s = node! {"type" => "atom", "mode" => mode, "family" => group.clone(), "text" => text.clone()};
                s.set("loc", loc.clone().into());
                if (group == "rel" || group == "bin")
                    && self.prev_atom_type == "text"
                    && let Some(loc) = &loc
                    && text_follows(&loc.lexer, loc.end)
                {
                    s.set("needsSpacing", V::Bool(true));
                }
            } else {
                if let Some(ascii) = tables().ascii_from_script.get(&text) {
                    self.consume();
                    let next = self.fetch_text()?;
                    let code = next.encode_utf16().next();
                    let font = if code == Some(0xfe01) {
                        "mathscr"
                    } else {
                        "mathcal"
                    };
                    if matches!(code, Some(0xfe00) | Some(0xfe01)) {
                        self.consume();
                    }
                    let body =
                        node! {"type" => "mathord", "mode" => "math", "text" => ascii.clone()};
                    body.set("loc", loc.into());
                    let f = node! {"type" => "font", "mode" => "math", "font" => font};
                    f.set("body", body);
                    return Ok(Some(f));
                }
                s = node! {"type" => group.clone(), "mode" => mode, "text" => text.clone()};
                s.set("loc", loc.into());
            }
            sym = s;
        } else if text.encode_utf16().next().is_some_and(|u| u >= 0x80)
            || combining_tail(&text).is_some()
        {
            if self.settings.strict && mode == "math" {
                let first = text.chars().next().unwrap_or(' ');
                return perr_at(
                    format!("Unicode text character \"{first}\" used in math mode"),
                    &nucleus,
                );
            }
            sym = node! {"type" => "textord", "mode" => "text", "text" => text.clone()};
            sym.set("loc", loc_range(&nucleus, None).into());
        } else {
            return Ok(None);
        }
        self.consume();
        if let Some(marks) = match_text {
            for accent in marks.chars() {
                let key = accent.to_string();
                let Some(entry) = functions::unicode_accent(&key) else {
                    return perr_at(format!("Unknown accent ' {accent}'"), &nucleus);
                };
                let command = if mode == "math" {
                    entry.math.or(entry.text)
                } else {
                    entry.text
                };
                let Some(command) = command else {
                    return perr_at(
                        format!("Accent {accent} unsupported in {mode} mode"),
                        &nucleus,
                    );
                };
                let a = node! {
                    "type" => "accent",
                    "mode" => mode,
                    "label" => command,
                    "isStretchy" => false,
                };
                a.set("loc", loc_range(&nucleus, None).into());
                a.set("base", sym);
                sym = a;
            }
        }
        Ok(Some(sym))
    }
}

/// `/^ *\\text/.test(input.slice(end))`.
fn text_follows(input: &[u16], end: usize) -> bool {
    let rest = input.get(end..).unwrap_or(&[]);
    let spaces = rest.iter().take_while(|u| **u == 0x20).count();
    let want: Vec<u16> = "\\text".encode_utf16().collect();
    rest[spaces..].starts_with(&want)
}
