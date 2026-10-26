//! `replace.js`: the Unicode Mathematical Alphanumeric offsets of each font variant.

fn script(ch: &str) -> Option<i64> {
    Some(match ch {
        "B" => 0x20EA,
        "E" | "F" => 0x20EB,
        "H" => 0x20C3,
        "I" => 0x20C7,
        "L" => 0x20C6,
        "M" => 0x20E6,
        "R" => 0x20C9,
        "e" => 0x20CA,
        "g" => 0x20A3,
        "o" => 0x20C5,
        _ => return None,
    })
}

fn frak(ch: &str) -> Option<i64> {
    Some(match ch {
        "C" => 0x20EA,
        "H" => 0x20C4,
        "I" => 0x20C8,
        "R" => 0x20CA,
        "Z" => 0x20CE,
        _ => return None,
    })
}

fn bbb(ch: &str) -> Option<i64> {
    Some(match ch {
        "C" => 0x20BF,
        "H" => 0x20C5,
        "N" => 0x20C7,
        "P" | "Q" => 0x20C9,
        "R" => 0x20CB,
        "Z" => 0x20CA,
        _ => return None,
    })
}

/// `bold`, `boldItalic`, `boldsf`, `bisf`: the offsets of the six variant Greek letters.
fn var_greek_table(ch: &str, table: [i64; 6]) -> Option<i64> {
    let i = match ch {
        "\u{03f5}" => 0,
        "\u{03d1}" => 1,
        "\u{03f0}" => 2,
        "\u{03c6}" => 3,
        "\u{03f1}" => 4,
        "\u{03d6}" => 5,
        _ => return None,
    };
    Some(table[i])
}

const BOLD: [i64; 6] = [0x1D2E7, 0x1D30C, 0x1D2EE, 0x1D319, 0x1D2EF, 0x1D30B];
const BOLD_ITALIC: [i64; 6] = [0x1D35B, 0x1D380, 0x1D362, 0x1D38D, 0x1D363, 0x1D37F];
const BOLDSF: [i64; 6] = [0x1D395, 0x1D3BA, 0x1D39C, 0x1D3C7, 0x1D39D, 0x1D3B9];
const BISF: [i64; 6] = [0x1D3CF, 0x1D3F4, 0x1D3D6, 0x1D401, 0x1D3D7, 0x1D3F3];

fn in_bold(ch: &str) -> bool {
    var_greek_table(ch, BOLD).is_some()
}

fn offset(block: &str, variant: &str, ch: &str) -> i64 {
    match block {
        "upperCaseLatin" => match variant {
            "bold" => 0x1D3BF,
            "italic" => 0x1D3F3,
            "bold-italic" => 0x1D427,
            "script" => script(ch).unwrap_or(0x1D45B),
            "script-bold" => 0x1D48F,
            "fraktur" => frak(ch).unwrap_or(0x1D4C3),
            "fraktur-bold" => 0x1D52B,
            "double-struck" => bbb(ch).unwrap_or(0x1D4F7),
            "sans-serif" => 0x1D55F,
            "sans-serif-bold" => 0x1D593,
            "sans-serif-italic" => 0x1D5C7,
            "sans-serif-bold-italic" => 0x1D63C,
            "monospace" => 0x1D62F,
            _ => 0,
        },
        "lowerCaseLatin" => match variant {
            "bold" => 0x1D3B9,
            "italic" => {
                if ch == "h" {
                    0x20A6
                } else {
                    0x1D3ED
                }
            }
            "bold-italic" => 0x1D421,
            "script" => script(ch).unwrap_or(0x1D455),
            "script-bold" => 0x1D489,
            "fraktur" => 0x1D4BD,
            "fraktur-bold" => 0x1D525,
            "double-struck" => 0x1D4F1,
            "sans-serif" => 0x1D559,
            "sans-serif-bold" => 0x1D58D,
            "sans-serif-italic" => 0x1D5C1,
            "sans-serif-bold-italic" => 0x1D5F5,
            "monospace" => 0x1D629,
            _ => 0,
        },
        "upperCaseGreek" => match variant {
            "bold" | "bold-italic" => 0x1D317,
            "italic" => 0x1D351,
            "sans-serif" | "sans-serif-bold" => 0x1D3C5,
            "sans-serif-bold-italic" => 0x1D3FF,
            _ => 0,
        },
        "lowerCaseGreek" => match variant {
            "bold" => 0x1D311,
            "italic" => 0x1D34B,
            "bold-italic" => {
                if ch == "\u{03d5}" {
                    0x1D37E
                } else {
                    0x1D385
                }
            }
            "sans-serif" | "sans-serif-bold" => 0x1D3BF,
            "sans-serif-bold-italic" => 0x1D3F9,
            _ => 0,
        },
        "varGreek" => match variant {
            "bold" => var_greek_table(ch, BOLD).unwrap_or(-51),
            "bold-italic" => var_greek_table(ch, BOLD_ITALIC).unwrap_or(0x3A),
            "sans-serif" | "sans-serif-bold" => var_greek_table(ch, BOLDSF).unwrap_or(0x74),
            "sans-serif-bold-italic" => var_greek_table(ch, BISF).unwrap_or(0xAE),
            _ => 0,
        },
        "numeral" => match variant {
            "bold" => 0x1D79E,
            "double-struck" => 0x1D7A8,
            "sans-serif" => 0x1D7B2,
            "sans-serif-bold" => 0x1D7BC,
            "monospace" => 0x1D7C6,
            _ => 0,
        },
        _ => 0,
    }
}

/// `variantChar(ch, variant)`; `ch` may hold more than one character, in which case only its
/// first code point is used, as in JS.
pub fn variant_char(ch: &str, variant: &str) -> String {
    let Some(first) = ch.chars().next() else {
        return ch.to_string();
    };
    let cp = first as i64;
    let block = if 0x40 < cp && cp < 0x5b {
        "upperCaseLatin"
    } else if 0x60 < cp && cp < 0x7b {
        "lowerCaseLatin"
    } else if 0x390 < cp && cp < 0x3AA {
        "upperCaseGreek"
    } else if (0x3B0 < cp && cp < 0x3CA) || ch == "\u{03d5}" {
        "lowerCaseGreek"
    } else if (0x1D6E1 < cp && cp < 0x1D6FC) || in_bold(ch) {
        "varGreek"
    } else if 0x2F < cp && cp < 0x3A {
        "numeral"
    } else {
        "other"
    };
    if block == "other" {
        return ch.to_string();
    }
    let target = cp + offset(block, variant, ch);
    u32::try_from(target)
        .ok()
        .and_then(char::from_u32)
        .map_or_else(|| ch.to_string(), |c| c.to_string())
}

/// `text.split("").map(c => variantChar(c, variant)).join("")`: a lone surrogate half of an
/// astral character matches no block, so those characters stay as they are.
pub fn variant_each_unit(text: &str, variant: &str) -> String {
    text.chars()
        .map(|c| {
            if (c as u32) < 0x10000 {
                variant_char(&c.to_string(), variant)
            } else {
                c.to_string()
            }
        })
        .collect()
}

pub fn small_caps(ch: &str) -> Option<&'static str> {
    Some(match ch {
        "a" => "ᴀ",
        "b" => "ʙ",
        "c" => "ᴄ",
        "d" => "ᴅ",
        "e" => "ᴇ",
        "f" => "ꜰ",
        "g" => "ɢ",
        "h" => "ʜ",
        "i" => "ɪ",
        "j" => "ᴊ",
        "k" => "ᴋ",
        "l" => "ʟ",
        "m" => "ᴍ",
        "n" => "ɴ",
        "o" => "ᴏ",
        "p" => "ᴘ",
        "q" => "ǫ",
        "r" => "ʀ",
        "s" => "s",
        "t" => "ᴛ",
        "u" => "ᴜ",
        "v" => "ᴠ",
        "w" => "ᴡ",
        "x" => "x",
        "y" => "ʏ",
        "z" => "ᴢ",
        _ => return None,
    })
}
