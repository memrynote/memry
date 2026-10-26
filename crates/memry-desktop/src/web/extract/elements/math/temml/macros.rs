//! `macros.js`: the macros defined as functions. The ones defined as strings are in
//! `tables.json`.

use super::macro_expander::{Expansion, MacroExpander, MacroFn, MacroResult};
use super::tables::tables;
use super::val::{R, Tok, jserr, perr, ulen};
use crate::web::extract::utils::js::trim;

pub fn function_macro(name: &str) -> Option<MacroFn> {
    Some(match name {
        "\\noexpand" => noexpand,
        "\\expandafter" => expandafter,
        "\\@firstoftwo" => firstoftwo,
        "\\@secondoftwo" => secondoftwo,
        "\\@ifnextchar" => ifnextchar,
        "\\TextOrMath" => text_or_math,
        "\\char" => char_macro,
        "\\dots" => dots,
        "\\dotso" => dotso,
        "\\dotsc" => dotsc,
        "\\cdots" => cdots,
        "\\tag@literal" => tag_literal,
        "\\Braket" => braket_macro,
        "\\Set" => set_upper,
        "\\set" => set_lower,
        "\\pdv@numerator" => pdv_numerator,
        "\\pdv@next" => pdv_next,
        _ => return None,
    })
}

fn exp(tokens: Vec<Tok>) -> MacroResult {
    MacroResult::Exp(Expansion {
        tokens,
        num_args: 0,
        delimiters: None,
        unexpandable: false,
    })
}

fn noexpand(c: &mut MacroExpander) -> R<MacroResult> {
    let t = c.pop_token()?;
    let text = t.borrow().text.clone();
    if c.is_expandable(&text) {
        t.borrow_mut().noexpand = true;
        t.borrow_mut().treat_as_relax = true;
    }
    Ok(exp(vec![t]))
}

fn expandafter(c: &mut MacroExpander) -> R<MacroResult> {
    let t = c.pop_token()?;
    c.expand_once(true)?;
    Ok(exp(vec![t]))
}

fn firstoftwo(c: &mut MacroExpander) -> R<MacroResult> {
    let mut args = c.consume_args(2, None)?;
    Ok(exp(args.swap_remove(0)))
}

fn secondoftwo(c: &mut MacroExpander) -> R<MacroResult> {
    let mut args = c.consume_args(2, None)?;
    Ok(exp(args.swap_remove(1)))
}

fn ifnextchar(c: &mut MacroExpander) -> R<MacroResult> {
    let mut args = c.consume_args(3, None)?;
    c.consume_spaces()?;
    let next = c.future()?;
    let same = args[0].len() == 1 && args[0][0].borrow().text == next.borrow().text;
    Ok(exp(if same {
        args.swap_remove(1)
    } else {
        args.swap_remove(2)
    }))
}

fn text_or_math(c: &mut MacroExpander) -> R<MacroResult> {
    let mut args = c.consume_args(2, None)?;
    Ok(exp(if c.mode == "text" {
        args.swap_remove(0)
    } else {
        args.swap_remove(1)
    }))
}

fn digit_to_number(ch: Option<u16>) -> Option<f64> {
    let c = char::from_u32(u32::from(ch?))?;
    c.to_digit(16)
        .map(f64::from)
        .filter(|_| c.is_ascii_hexdigit())
}

fn first_unit(s: &str) -> Option<u16> {
    s.encode_utf16().next()
}

fn append_char_numbers(mut number: f64, num_str: &str, base: f64) -> f64 {
    for unit in num_str.encode_utf16().skip(1) {
        number *= base;
        number += digit_to_number(Some(unit)).unwrap_or(f64::NAN);
    }
    number
}

fn next_char_number(c: &mut MacroExpander) -> R<(Option<f64>, String)> {
    let text = c.future()?.borrow().text.clone();
    if text == "EOF" {
        return Ok((None, String::new()));
    }
    Ok((digit_to_number(first_unit(&text)), text))
}

fn char_macro(c: &mut MacroExpander) -> R<MacroResult> {
    let mut token = c.pop_token()?;
    let mut base: Option<f64> = None;
    let mut number: f64 = 0.0;
    let text = token.borrow().text.clone();
    if text == "'" {
        base = Some(8.0);
        token = c.pop_token()?;
    } else if text == "\"" {
        base = Some(16.0);
        token = c.pop_token()?;
    } else if text == "`" {
        token = c.pop_token()?;
        let t = token.borrow().text.clone();
        if t.starts_with('\\') {
            number = f64::from(t.encode_utf16().nth(1).unwrap_or(0));
            if t.encode_utf16().nth(1).is_none() {
                number = f64::NAN;
            }
        } else if t == "EOF" {
            return perr("\\char` missing argument");
        } else {
            number = f64::from(first_unit(&t).unwrap_or(0));
        }
    } else {
        base = Some(10.0);
    }
    if let Some(base) = base {
        let text = token.borrow().text.clone();
        let first = digit_to_number(first_unit(&text));
        let Some(first) = first.filter(|n| *n < base) else {
            return perr(format!("Invalid base-{base} digit {text}"));
        };
        number = append_char_numbers(first, &text, base);
        let (mut digit, mut num_str) = next_char_number(c)?;
        while let Some(d) = digit.filter(|d| *d < base) {
            number *= base;
            number += d;
            number = append_char_numbers(number, &num_str, base);
            c.pop_token()?;
            (digit, num_str) = next_char_number(c)?;
        }
    }
    Ok(MacroResult::Text(format!(
        "\\@char{{{}}}",
        super::val::num_str(number)
    )))
}

fn dots_by_token(name: &str) -> Option<&'static str> {
    Some(match name {
        "," => "\\dotsc",
        "\\not"
        | "+"
        | "="
        | "<"
        | ">"
        | "-"
        | "*"
        | ":"
        | "\\DOTSB"
        | "\\coprod"
        | "\\bigvee"
        | "\\bigwedge"
        | "\\biguplus"
        | "\\bigcap"
        | "\\bigcup"
        | "\\prod"
        | "\\sum"
        | "\\bigotimes"
        | "\\bigoplus"
        | "\\bigodot"
        | "\\bigsqcap"
        | "\\bigsqcup"
        | "\\bigtimes"
        | "\\And"
        | "\\longrightarrow"
        | "\\Longrightarrow"
        | "\\longleftarrow"
        | "\\Longleftarrow"
        | "\\longleftrightarrow"
        | "\\Longleftrightarrow"
        | "\\mapsto"
        | "\\longmapsto"
        | "\\hookrightarrow"
        | "\\doteq"
        | "\\mathbin"
        | "\\mathrel"
        | "\\relbar"
        | "\\Relbar"
        | "\\xrightarrow"
        | "\\xleftarrow" => "\\dotsb",
        "\\DOTSI" | "\\int" | "\\oint" | "\\iint" | "\\iiint" | "\\iiiint" => "\\dotsi",
        "\\DOTSX" => "\\dotsx",
        _ => return None,
    })
}

const SPACE_AFTER_DOTS: [&str; 18] = [
    ")",
    "]",
    "\\rbrack",
    "\\}",
    "\\rbrace",
    "\\rangle",
    "\\rceil",
    "\\rfloor",
    "\\rgroup",
    "\\rmoustache",
    "\\right",
    "\\bigr",
    "\\biggr",
    "\\Bigr",
    "\\Biggr",
    "$",
    ";",
    ".",
];

fn space_after_dots(next: &str) -> bool {
    SPACE_AFTER_DOTS.contains(&next) || next == ","
}

fn dots(c: &mut MacroExpander) -> R<MacroResult> {
    let mut thedots = "\\dotso";
    let next = c.expand_after_future()?.borrow().text.clone();
    if let Some(d) = dots_by_token(&next) {
        thedots = d;
    } else if next.chars().take(4).collect::<String>() == "\\not" {
        thedots = "\\dotsb";
    } else if let Some(sym) = tables().symbols_math.get(&next)
        && (sym.group == "bin" || sym.group == "rel")
    {
        thedots = "\\dotsb";
    }
    Ok(MacroResult::Text(thedots.to_string()))
}

fn dotso(c: &mut MacroExpander) -> R<MacroResult> {
    let next = c.future()?.borrow().text.clone();
    Ok(MacroResult::Text(
        if space_after_dots(&next) {
            "\\ldots\\,"
        } else {
            "\\ldots"
        }
        .to_string(),
    ))
}

fn dotsc(c: &mut MacroExpander) -> R<MacroResult> {
    let next = c.future()?.borrow().text.clone();
    Ok(MacroResult::Text(
        if space_after_dots(&next) && next != "," {
            "\\ldots\\,"
        } else {
            "\\ldots"
        }
        .to_string(),
    ))
}

fn cdots(c: &mut MacroExpander) -> R<MacroResult> {
    let next = c.future()?.borrow().text.clone();
    Ok(MacroResult::Text(
        if space_after_dots(&next) {
            "\\@cdots\\,"
        } else {
            "\\@cdots"
        }
        .to_string(),
    ))
}

fn tag_literal(c: &mut MacroExpander) -> R<MacroResult> {
    if c.macros.get("\\df@tag").is_some() {
        return perr("Multiple \\tag");
    }
    Ok(MacroResult::Text("\\gdef\\df@tag{\\text{#1}}".to_string()))
}

fn string_from_arg(arg: &[Tok]) -> String {
    arg.iter().rev().map(|t| t.borrow().text.clone()).collect()
}

/// `recreateArgStr(context)`, as UTF-16 units.
fn recreate_arg_str(c: &mut MacroExpander) -> R<Vec<u16>> {
    let mut args = c.consume_args(1, None)?;
    let tokens = args.swap_remove(0);
    let loc_start = |t: &Tok| t.borrow().loc.as_ref().map(|l| l.start);
    let Some(last) = tokens.last() else {
        return jserr("Cannot read properties of undefined (reading 'loc')");
    };
    let Some(mut expected) = loc_start(last) else {
        return jserr("Cannot read properties of undefined (reading 'start')");
    };
    let mut out: Vec<u16> = Vec::new();
    for t in tokens.iter().rev() {
        let Some(actual) = loc_start(t) else {
            return jserr("Cannot read properties of undefined (reading 'start')");
        };
        if actual > expected {
            out.push(0x20);
            expected = actual;
        }
        let text = t.borrow().text.clone();
        out.extend(text.encode_utf16());
        expected += ulen(&text);
    }
    Ok(out)
}

/// `/\|\||\||\\\|/` at or after `from`: `(index, length)`.
fn find_vert(s: &[u16], from: usize) -> Option<(usize, usize)> {
    let mut p = from;
    while p < s.len() {
        if s[p] == 0x7C && s.get(p + 1) == Some(&0x7C) {
            return Some((p, 2));
        }
        if s[p] == 0x7C {
            return Some((p, 1));
        }
        if s[p] == 0x5C && s.get(p + 1) == Some(&0x7C) {
            return Some((p, 2));
        }
        p += 1;
    }
    None
}

fn replace_vert(arg: &[u16], index: usize, len: usize) -> Vec<u16> {
    let ch = if len == 1 { "\\vert" } else { "\\Vert" };
    let replacement: Vec<u16> = format!("}}\\,\\middle{ch}\\,{{").encode_utf16().collect();
    let mut out = arg[..index].to_vec();
    out.extend(replacement);
    out.extend_from_slice(&arg[index + len..]);
    out
}

fn braket_macro(c: &mut MacroExpander) -> R<MacroResult> {
    let mut arg = recreate_arg_str(c)?;
    let mut last_index = 0usize;
    while let Some((index, len)) = find_vert(&arg, last_index) {
        // `regEx.lastIndex` is the end of the match in the string before the replacement.
        last_index = index + len;
        arg = replace_vert(&arg, index, len);
    }
    Ok(MacroResult::Text(format!(
        "\\left\\langle{{{}}}\\right\\rangle",
        String::from_utf16_lossy(&arg)
    )))
}

fn set_upper(c: &mut MacroExpander) -> R<MacroResult> {
    let mut arg = recreate_arg_str(c)?;
    if let Some((index, len)) = find_vert(&arg, 0) {
        arg = replace_vert(&arg, index, len);
    }
    Ok(MacroResult::Text(format!(
        "\\left\\{{\\:{{{}}}\\:\\right\\}}",
        String::from_utf16_lossy(&arg)
    )))
}

fn set_lower(c: &mut MacroExpander) -> R<MacroResult> {
    let arg = String::from_utf16_lossy(&recreate_arg_str(c)?);
    Ok(MacroResult::Text(format!(
        "\\{{{{{}}}\\}}",
        arg.replacen('|', "}\\mid{", 1)
    )))
}

fn pdv_helper(args: &[Vec<Tok>]) -> R<(String, String, String)> {
    let Some(first) = args[0].first() else {
        return jserr("Cannot read properties of undefined (reading 'text')");
    };
    let numerator = first.borrow().text.clone();
    let joined = string_from_arg(&args[1]);
    let denoms: Vec<&str> = joined.split(',').collect();
    let power = denoms.len().to_string();
    let num_op = if power == "1" {
        "\\partial".to_string()
    } else {
        format!("\\partial^{power}")
    };
    let mut denominator = String::new();
    for e in &denoms {
        denominator.push_str(&format!("\\partial {}\\,", trim(e)));
    }
    if let Some(stripped) = denominator.strip_suffix("\\,") {
        denominator = stripped.to_string();
    }
    Ok((numerator, num_op, denominator))
}

fn pdv_numerator(c: &mut MacroExpander) -> R<MacroResult> {
    let args = c.consume_args(2, None)?;
    let (numerator, num_op, denominator) = pdv_helper(&args)?;
    Ok(MacroResult::Text(format!(
        "\\frac{{{num_op} {numerator}}}{{{denominator}}}"
    )))
}

fn pdv_next(c: &mut MacroExpander) -> R<MacroResult> {
    let args = c.consume_args(2, None)?;
    let (numerator, num_op, denominator) = pdv_helper(&args)?;
    Ok(MacroResult::Text(format!(
        "\\frac{{{num_op}}}{{{denominator}}} {numerator}"
    )))
}
