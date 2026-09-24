//! `String.prototype.localeCompare` for the task sorts and groups, without ICU.
//!
//! Desktop orders titles, project names, folder paths and note titles with
//! `localeCompare`, which in Node and Electron is ICU's root collation. The
//! crate has no ICU, so this is a small model of that collation that is exact
//! for ASCII and for Latin letters with diacritics, and approximate beyond:
//!
//! - **Level 1 (primary)** compares base characters, case- and
//!   accent-insensitively, in ICU's class order: whitespace < punctuation <
//!   symbols < currency < digits < Latin letters < other scripts. Spaces and
//!   punctuation are not ignorable (CLDR root is "non-ignorable").
//! - **Level 2 (secondary)** compares accents: a base letter carries the
//!   common weight and each diacritic adds one weight after it, so an
//!   unaccented string sorts first and `é` sorts before `è` as in ICU.
//! - **Level 3 (tertiary)** compares case: lowercase before uppercase.
//!
//! A string's levels are compared whole, in order, exactly as a collation key
//! is: a primary difference anywhere wins over any accent or case difference.
//! Strings equal at all three levels compare `Equal`, as `localeCompare`
//! returns `0` for them.
//!
//! The tables were read from Node 22's ICU 78 (`localeCompare` over each
//! character class). Characters outside them fall back to a rule by class:
//! whitespace sorts as a space variant, other letters after Latin in code point
//! order, anything else among the symbols in code point order.

use std::cmp::Ordering;

/// One collation element: the three weights a character contributes.
#[derive(Debug, Clone, Copy)]
struct Element {
    /// `0` for a diacritic, which has no primary weight of its own.
    primary: u32,
    secondary: u16,
    tertiary: u8,
}

/// Secondary weight of a base character (ICU's "common").
const COMMON: u16 = 1;
/// Tertiary weights.
const LOWER: u8 = 0;
const UPPER: u8 = 1;
/// A compatibility variant (`ª`, `¹`, `ĳ`) of a lowercase base.
const VARIANT: u8 = 2;

const SYMBOL_FALLBACK_BASE: u32 = 1_000;
const DIGIT_BASE: u32 = 2_000_000;
const LATIN_BASE: u32 = 2_100_000;
const OTHER_LETTER_BASE: u32 = 3_000_000;

/// Whitespace, punctuation, symbols and currency, in ICU root order. Characters
/// in one entry share a primary weight and differ at the tertiary level, in the
/// order written. Kept dense (rustfmt would put each entry on its own line).
#[rustfmt::skip]
const PUNCTUATION_ORDER: &[&str] = &[
    "\u{9}", "\u{a}", "\u{b}", "\u{c}", "\u{d}", "\u{85}", "\u{2028}", "\u{2029}",
    "\u{20}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2008}\u{2009}\u{200a}\u{a0}\u{2007}\u{202f}",
    "\u{203e}", "_", "\u{2017}", "-", "\u{2010}\u{2011}", "\u{2012}", "\u{2013}", "\u{2014}",
    "\u{2015}", "\u{2053}", ",", ";", "\u{204f}", ":", "!", "\u{203c}", "\u{2049}", "\u{a1}",
    "?", "\u{2048}", "\u{2047}", "\u{bf}", "\u{203d}", ".\u{2024}", "\u{2025}", "\u{2026}",
    "\u{b7}", "\u{2055}", "\u{2056}", "\u{2058}", "\u{2059}", "\u{205a}", "\u{205b}",
    "\u{205c}", "\u{205d}", "\u{205e}", "'\u{2018}\u{2019}\u{201a}\u{201b}", "\u{2039}",
    "\u{203a}", "\"\u{201c}\u{201d}\u{201e}\u{201f}", "\u{ab}", "\u{bb}", "(", ")", "[", "]",
    "{", "}", "\u{2045}", "\u{2046}", "\u{2016}", "\u{a7}", "\u{b6}", "\u{204b}", "@", "*",
    "\u{204e}", "\u{2051}", "/", "\\", "&", "\u{204a}", "#", "%", "\u{2030}", "\u{2031}",
    "\u{2020}", "\u{2021}", "\u{2022}", "\u{2023}", "\u{2027}", "\u{2043}", "\u{204c}",
    "\u{204d}", "\u{2032}", "\u{2033}", "\u{2034}", "\u{2057}", "\u{2035}", "\u{2036}",
    "\u{2037}", "\u{2038}", "\u{203b}", "\u{203f}", "\u{2054}", "\u{2040}", "\u{2050}",
    "\u{2041}", "\u{2042}", "`", "\u{b4}", "^", "\u{af}", "\u{a8}", "\u{b8}", "\u{b0}",
    "\u{a9}", "\u{ae}", "+", "\u{b1}", "\u{f7}", "\u{d7}", "<", "=", ">", "\u{ac}", "|",
    "\u{a6}", "~", "\u{2052}", "\u{2044}", "\u{a4}", "\u{a2}", "$", "\u{a3}", "\u{a5}",
    "\u{20ac}",
];

/// Combining diacritics in ICU's secondary order. A mark not listed sorts
/// after all of these, in code point order.
const MARK_ORDER: &[u32] = &[
    0x0332, 0x0313, 0x0314, 0x0301, 0x0300, 0x0306, 0x0302, 0x030c, 0x030a, 0x0342, 0x0308, 0x0344,
    0x030b, 0x0303, 0x0307, 0x0338, 0x0327, 0x0328, 0x0304,
];

/// Precomposed Latin letters by their one diacritic: `(mark, letters, bases)`,
/// where `bases` holds each letter's ASCII base at the same position (the
/// canonical decomposition, read from `String.prototype.normalize('NFD')`).
const DECOMPOSITIONS: &[(u32, &str, &str)] = &[
    (0x300, "ÀÈÌÒÙàèìòùǸǹ", "AEIOUaeiouNn"),
    (
        0x301,
        "ÁÉÍÓÚÝáéíóúýĆćĹĺŃńŔŕŚśŹźǴǵ",
        "AEIOUYaeiouyCcLlNnRrSsZzGg",
    ),
    (
        0x302,
        "ÂÊÎÔÛâêîôûĈĉĜĝĤĥĴĵŜŝŴŵŶŷ",
        "AEIOUaeiouCcGgHhJjSsWwYy",
    ),
    (0x303, "ÃÑÕãñõĨĩŨũ", "ANOanoIiUu"),
    (0x304, "ĀāĒēĪīŌōŪūȲȳ", "AaEeIiOoUuYy"),
    (0x306, "ĂăĔĕĞğĬĭŎŏŬŭ", "AaEeGgIiOoUu"),
    (0x307, "ĊċĖėĠġİŻżȦȧȮȯ", "CcEeGgIZzAaOo"),
    (0x308, "ÄËÏÖÜäëïöüÿŸ", "AEIOUaeiouyY"),
    (0x311, "ȂȃȆȇȊȋȎȏȒȓȖȗ", "AaEeIiOoRrUu"),
    (0x326, "ȘșȚț", "SsTt"),
    (0x327, "ÇçĢģĶķĻļŅņŖŗŞşŢţȨȩ", "CcGgKkLlNnRrSsTtEe"),
    (0x328, "ĄąĘęĮįŲųǪǫ", "AaEeIiUuOo"),
    (0x30a, "ÅåŮů", "AaUu"),
    (
        0x30c,
        "ČčĎďĚěĽľŇňŘřŠšŤťŽžǍǎǏǐǑǒǓǔǦǧǨǩǰȞȟ",
        "CcDdEeLlNnRrSsTtZzAaIiOoUuGgKkjHh",
    ),
    (0x30b, "ŐőŰű", "OoUu"),
    (0x31b, "ƠơƯư", "OoUu"),
    (0x30f, "ȀȁȄȅȈȉȌȍȐȑȔȕ", "AaEeIiOoRrUu"),
];

/// The secondary difference ICU gives letters with a stroke or ligature form
/// (`ø`, `ł`, `đ`, `æ`, `ß`): modelled as the stroke overlay mark.
const STROKE_MARK: u32 = 0x0338;

/// `a.localeCompare(b)` under ICU root collation (see the module docs for
/// what is exact and what is approximate).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let a = elements(a);
    let b = elements(b);
    let primaries = |list: &[Element]| -> Vec<u32> {
        list.iter()
            .map(|e| e.primary)
            .filter(|&weight| weight != 0)
            .collect()
    };
    primaries(&a)
        .cmp(&primaries(&b))
        .then_with(|| {
            let secondaries =
                |list: &[Element]| -> Vec<u16> { list.iter().map(|e| e.secondary).collect() };
            secondaries(&a).cmp(&secondaries(&b))
        })
        .then_with(|| {
            let tertiaries =
                |list: &[Element]| -> Vec<u8> { list.iter().map(|e| e.tertiary).collect() };
            tertiaries(&a).cmp(&tertiaries(&b))
        })
}

fn elements(text: &str) -> Vec<Element> {
    let mut out = Vec::with_capacity(text.len());
    for c in text.chars() {
        push_elements(c, &mut out);
    }
    out
}

fn push_elements(c: char, out: &mut Vec<Element>) {
    if c.is_ascii_alphabetic() {
        out.push(latin(c, 0, case_of(c)));
        return;
    }
    if c.is_ascii_digit() {
        out.push(base(DIGIT_BASE + u32::from(c) - u32::from('0'), LOWER));
        return;
    }
    if ('\u{300}'..='\u{36f}').contains(&c) {
        // U+0340, U+0341 and U+0343 are canonical duplicates of these three;
        // U+034F (combining grapheme joiner) carries no weight.
        match u32::from(c) {
            0x034f => {}
            0x0340 => out.push(mark(0x0300)),
            0x0341 => out.push(mark(0x0301)),
            0x0343 => out.push(mark(0x0313)),
            code => out.push(mark(code)),
        }
        return;
    }
    if let Some((rank, variant)) = punctuation_rank(c) {
        out.push(base(1 + rank, variant));
        return;
    }
    if let Some((base_letter, mark_code)) = decomposition(c) {
        out.push(latin(base_letter, 0, case_of(c)));
        out.push(mark(mark_code));
        return;
    }
    if push_special_letter(c, out) {
        return;
    }
    if is_ignorable(c) {
        return;
    }
    if c.is_whitespace() {
        out.push(base(1 + space_rank(), VARIANT));
    } else if c.is_alphabetic() {
        let lower = c.to_lowercase().next().unwrap_or(c);
        let tertiary = if c.is_uppercase() { UPPER } else { LOWER };
        out.push(base(OTHER_LETTER_BASE + u32::from(lower), tertiary));
    } else {
        out.push(base(SYMBOL_FALLBACK_BASE + u32::from(c), LOWER));
    }
}

/// Latin letters with no canonical decomposition, which ICU sorts as a base
/// letter plus a secondary difference, as an expansion, or as a letter of
/// their own right after a base. Returns whether `c` was one.
fn push_special_letter(c: char, out: &mut Vec<Element>) -> bool {
    let case = case_of(c);
    let with_stroke = |letter: char, out: &mut Vec<Element>| {
        out.push(latin(letter, 0, case));
        out.push(mark(STROKE_MARK));
    };
    match c {
        'ø' | 'Ø' => with_stroke('o', out),
        'đ' | 'Đ' | 'ð' | 'Ð' => with_stroke('d', out),
        'ħ' | 'Ħ' => with_stroke('h', out),
        'ł' | 'Ł' | 'ŀ' | 'Ŀ' => with_stroke('l', out),
        'ſ' => with_stroke('s', out),
        'æ' | 'Æ' => {
            with_stroke('a', out);
            out.push(latin('e', 0, case));
        }
        'œ' | 'Œ' => {
            with_stroke('o', out);
            out.push(latin('e', 0, case));
        }
        'ß' => {
            with_stroke('s', out);
            out.push(latin('s', 0, LOWER));
        }
        'ĳ' | 'Ĳ' => {
            let tertiary = if c == 'Ĳ' { VARIANT + 1 } else { VARIANT };
            out.push(latin('i', 0, tertiary));
            out.push(latin('j', 0, tertiary));
        }
        'ª' => out.push(latin('a', 0, VARIANT)),
        'º' => out.push(latin('o', 0, VARIANT)),
        'ı' => out.push(latin('i', 1, LOWER)),
        'ĸ' => out.push(latin('q', 1, LOWER)),
        'ŋ' | 'Ŋ' => out.push(latin('n', 1, case)),
        'ŧ' | 'Ŧ' => out.push(latin('t', 1, case)),
        'þ' | 'Þ' => out.push(latin('z', 1, case)),
        '¹' => out.push(base(DIGIT_BASE + 1, VARIANT)),
        '²' => out.push(base(DIGIT_BASE + 2, VARIANT)),
        '³' => out.push(base(DIGIT_BASE + 3, VARIANT)),
        'µ' => out.push(base(OTHER_LETTER_BASE + 0x03bc, LOWER)),
        _ => return false,
    }
    true
}

/// Controls and invisible format characters carry no weight at all.
fn is_ignorable(c: char) -> bool {
    matches!(
        c,
        '\u{ad}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}'
            | '\u{feff}'
    ) || c.is_control()
}

fn base(primary: u32, tertiary: u8) -> Element {
    Element {
        primary,
        secondary: COMMON,
        tertiary,
    }
}

/// A Latin letter's element; `after` places a letter of its own right just
/// after its base (`ı` after `i`, `þ` after `z`).
fn latin(letter: char, after: u32, tertiary: u8) -> Element {
    let index = u32::from(letter.to_ascii_lowercase()).saturating_sub(u32::from('a'));
    base(LATIN_BASE + index * 2 + after, tertiary)
}

fn mark(code: u32) -> Element {
    let rank = MARK_ORDER
        .iter()
        .position(|&listed| listed == code)
        .and_then(|index| u16::try_from(index).ok())
        .unwrap_or_else(|| {
            let listed = u16::try_from(MARK_ORDER.len()).unwrap_or(u16::MAX / 2);
            listed.saturating_add(u16::try_from(code.saturating_sub(0x0300)).unwrap_or(0))
        });
    Element {
        primary: 0,
        secondary: COMMON + 1 + rank,
        tertiary: LOWER,
    }
}

fn case_of(c: char) -> u8 {
    if c.is_uppercase() { UPPER } else { LOWER }
}

/// `(rank, tertiary)` of a whitespace, punctuation or symbol character.
fn punctuation_rank(c: char) -> Option<(u32, u8)> {
    PUNCTUATION_ORDER
        .iter()
        .enumerate()
        .find_map(|(rank, group)| {
            let position = group.chars().position(|member| member == c)?;
            Some((
                u32::try_from(rank).ok()?,
                u8::try_from(position).unwrap_or(u8::MAX),
            ))
        })
}

fn space_rank() -> u32 {
    punctuation_rank(' ').map_or(0, |(rank, _)| rank)
}

/// `(ASCII base, diacritic)` of a precomposed Latin letter.
fn decomposition(c: char) -> Option<(char, u32)> {
    DECOMPOSITIONS
        .iter()
        .find_map(|(mark_code, letters, bases)| {
            let position = letters.chars().position(|letter| letter == c)?;
            Some((bases.chars().nth(position)?, *mark_code))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pairs whose `localeCompare` result was read from Node 22 (ICU 78).
    #[test]
    fn matches_node_for_latin_text() {
        let cases: &[(&str, &str, Ordering)] = &[
            ("a", "A", Ordering::Less),
            ("Apple pie", "banana bread", Ordering::Less),
            ("banana bread", "Banana split", Ordering::Less),
            ("Éclair", "alpha", Ordering::Greater),
            ("Éclair", "Work", Ordering::Less),
            ("eclair", "Éclair", Ordering::Less),
            ("écl", "ecm", Ordering::Less),
            ("é", "è", Ordering::Less),
            ("Write report", "write report", Ordering::Greater),
            ("a b", "ab", Ordering::Less),
            ("a-b", "a b", Ordering::Greater),
            ("a_b", "a-b", Ordering::Less),
            ("9", "a", Ordering::Less),
            ("!", "0", Ordering::Less),
            ("$", "0", Ordering::Less),
            ("08:30", "09:00", Ordering::Less),
            ("Acme", "Acme/Planning", Ordering::Less),
            ("Acme/Planning", "beta", Ordering::Less),
            ("", "a", Ordering::Less),
            ("ø", "p", Ordering::Less),
            ("ø", "o", Ordering::Greater),
            ("þ", "z", Ordering::Greater),
            ("straße", "strasse", Ordering::Greater),
            ("straße", "strast", Ordering::Less),
            ("a\u{301}", "á", Ordering::Equal),
            ("Ä", "ä", Ordering::Greater),
        ];
        let mismatches: Vec<String> = cases
            .iter()
            .filter(|(a, b, expected)| locale_compare(a, b) != *expected)
            .map(|(a, b, expected)| {
                format!(
                    "{a:?} vs {b:?}: expected {expected:?}, got {:?}",
                    locale_compare(a, b)
                )
            })
            .collect();
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    }
}
