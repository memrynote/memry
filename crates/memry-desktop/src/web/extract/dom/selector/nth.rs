//! Port of nth-check 2.1.1 (`lib/esm/parse.js`, `compile.js`).

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::trim;

/// What `nthCheck(formula)` returns: `boolbase.falseFunc`, `boolbase.trueFunc`, or a predicate
/// over a zero-based index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NthCheck {
    False,
    True,
    /// `index <= b`
    AtMost(i64),
    /// `index === b`
    Exactly(i64),
    /// `index >= b`
    AtLeast(i64),
    /// `index >= b && index % abs_a === b_mod` (a > 1)
    Ascending {
        b: i64,
        abs_a: i64,
        b_mod: i64,
    },
    /// `index <= b && index % abs_a === b_mod` (a < -1)
    Descending {
        b: i64,
        abs_a: i64,
        b_mod: i64,
    },
}

impl NthCheck {
    pub fn matches(self, index: i64) -> bool {
        match self {
            NthCheck::False => false,
            NthCheck::True => true,
            NthCheck::AtMost(b) => index <= b,
            NthCheck::Exactly(b) => index == b,
            NthCheck::AtLeast(b) => index >= b,
            NthCheck::Ascending { b, abs_a, b_mod } => index >= b && index % abs_a == b_mod,
            NthCheck::Descending { b, abs_a, b_mod } => index <= b && index % abs_a == b_mod,
        }
    }
}

fn parse_error(formula: &str) -> ExtractError {
    ExtractError::Selector(format!("n-th rule couldn't be parsed ('{formula}')"))
}

/// `parse(formula)`: the step `a` and offset `b` of `an+b`.
pub fn parse(formula: &str) -> Result<(i64, i64), ExtractError> {
    let formula = trim(formula).to_lowercase();
    if formula == "even" {
        return Ok((2, 0));
    }
    if formula == "odd" {
        return Ok((2, 1));
    }
    let chars: Vec<char> = formula.chars().collect();
    let mut idx = 0usize;
    let mut a = 0i64;
    let mut sign = read_sign(&chars, &mut idx);
    let mut number = read_number(&chars, &mut idx);
    if idx < chars.len() && chars[idx] == 'n' {
        idx += 1;
        a = sign * number.unwrap_or(1);
        skip_whitespace(&chars, &mut idx);
        if idx < chars.len() {
            sign = read_sign(&chars, &mut idx);
            skip_whitespace(&chars, &mut idx);
            number = read_number(&chars, &mut idx);
        } else {
            sign = 0;
            number = Some(0);
        }
    }
    match number {
        Some(n) if idx >= chars.len() => Ok((a, sign * n)),
        _ => Err(parse_error(&formula)),
    }
}

fn read_sign(chars: &[char], idx: &mut usize) -> i64 {
    match chars.get(*idx) {
        Some('-') => {
            *idx += 1;
            -1
        }
        Some('+') => {
            *idx += 1;
            1
        }
        _ => 1,
    }
}

fn read_number(chars: &[char], idx: &mut usize) -> Option<i64> {
    let start = *idx;
    let mut value: i64 = 0;
    while let Some(c) = chars.get(*idx)
        && c.is_ascii_digit()
    {
        value = value
            .saturating_mul(10)
            .saturating_add(i64::from(*c as u8 - b'0'));
        *idx += 1;
    }
    (*idx != start).then_some(value)
}

fn skip_whitespace(chars: &[char], idx: &mut usize) {
    while let Some(c) = chars.get(*idx)
        && matches!(c, '\t' | '\n' | '\u{c}' | '\r' | ' ')
    {
        *idx += 1;
    }
}

/// `compile([a, b])`.
pub fn compile(a: i64, b: i64) -> NthCheck {
    let b = b - 1;
    if b < 0 && a <= 0 {
        return NthCheck::False;
    }
    if a == -1 {
        return NthCheck::AtMost(b);
    }
    if a == 0 {
        return NthCheck::Exactly(b);
    }
    if a == 1 {
        return if b < 0 {
            NthCheck::True
        } else {
            NthCheck::AtLeast(b)
        };
    }
    let abs_a = a.abs();
    let b_mod = ((b % abs_a) + abs_a) % abs_a;
    if a > 1 {
        NthCheck::Ascending { b, abs_a, b_mod }
    } else {
        NthCheck::Descending { b, abs_a, b_mod }
    }
}

/// `nthCheck(formula)`.
pub fn nth_check(formula: &str) -> Result<NthCheck, ExtractError> {
    let (a, b) = parse(formula)?;
    Ok(compile(a, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values come from `nthCheck(formula)(index)` in nth-check 2.1.1.
    fn bits(formula: &str, upto: i64) -> String {
        let check = nth_check(formula).expect("formula parses");
        (0..upto)
            .map(|i| if check.matches(i) { '1' } else { '0' })
            .collect()
    }

    #[test]
    fn formulas_match_nth_check() {
        assert_eq!(bits("2n+3", 8), "00101010");
        assert_eq!(bits("odd", 6), "101010");
        assert_eq!(bits("even", 6), "010101");
        assert_eq!(bits("3", 6), "001000");
        assert_eq!(bits("-n+3", 6), "111000");
        assert_eq!(bits("-2n+5", 6), "101010");
        assert_eq!(bits("n", 4), "1111");
        assert_eq!(bits("0n+0", 4), "0000");
        assert_eq!(bits("+3n - 2", 8), "10010010");
    }

    #[test]
    fn bad_formulas_throw() {
        assert!(nth_check("2 of .x").is_err());
        assert!(nth_check("").is_err());
        assert!(nth_check("n+").is_err());
    }

    #[test]
    fn always_true_and_always_false_are_distinguished() {
        assert_eq!(nth_check("n").unwrap(), NthCheck::True);
        assert_eq!(nth_check("n+1").unwrap(), NthCheck::AtLeast(0));
        assert_eq!(nth_check("n+2").unwrap(), NthCheck::AtLeast(1));
        assert_eq!(nth_check("-n").unwrap(), NthCheck::False);
    }
}
