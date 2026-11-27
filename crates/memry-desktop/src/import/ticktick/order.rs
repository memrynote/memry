//! `bigintCompare` (`packages/importers/src/ticktick/map-rows.ts`): TickTick's `Order` and
//! `Column Order` cells compared as `BigInt(text.trim() || '0')`, `0n` when `BigInt` throws.
//!
//! The key is exact for every value that fits an `i128`, and for two larger values of the same
//! kind (both decimal, or both `0x`/`0o`/`0b`). A larger decimal against a larger `0x`/`0o`/`0b`
//! value compares by bit length, which needs no quadratic base conversion; they can disagree
//! with `BigInt` only when the two bit lengths are within 3 of each other.

use std::cmp::Reverse;

use memry_core::markdown::frontmatter::js_trim;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum OrderKey {
    /// Below `i128::MIN`, decimal: (digit count, digits), the larger more negative.
    NegativeBig(Reverse<(usize, String)>),
    Small(i128),
    /// Above `i128::MAX`: (bit length, or a decimal's lower bound of it; 0 decimal or 1 binary;
    /// the digits or bits without leading zeros).
    PositiveBig(u64, u8, String),
}

/// `log2(10)`.
const LOG2_10: f64 = std::f64::consts::LOG2_10;

/// `StringToBigInt` of a trimmed, non-empty text: `[+-]digits`, or `0x`, `0o` or `0b` digits.
fn parse(text: &str) -> Option<OrderKey> {
    let prefixed = |prefixes: [&str; 2], radix: u32, bits: usize| {
        let digits = prefixes.iter().find_map(|p| text.strip_prefix(p))?;
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return None;
        }
        let binary: String = digits
            .chars()
            .flat_map(|c| {
                let d = c.to_digit(radix).expect("checked above");
                (0..bits)
                    .rev()
                    .map(move |i| if d >> i & 1 == 1 { '1' } else { '0' })
            })
            .skip_while(|&b| b == '0')
            .collect();
        Some(if binary.len() <= 127 {
            OrderKey::Small(i128::from_str_radix(&binary, 2).unwrap_or(0))
        } else {
            OrderKey::PositiveBig(binary.len() as u64, 1, binary)
        })
    };
    if let Some(key) = prefixed(["0x", "0X"], 16, 4)
        .or_else(|| prefixed(["0o", "0O"], 8, 3))
        .or_else(|| prefixed(["0b", "0B"], 2, 1))
    {
        return Some(key);
    }
    let (negative, digits) = match text.as_bytes()[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Ok(value) = text.parse::<i128>() {
        return Some(OrderKey::Small(value));
    }
    let digits = digits.trim_start_matches('0').to_owned();
    let len = digits.len();
    Some(if negative {
        OrderKey::NegativeBig(Reverse((len, digits)))
    } else {
        let bits = ((len - 1) as f64 * LOG2_10).floor() as u64 + 1;
        OrderKey::PositiveBig(bits, 0, digits)
    })
}

/// `toBig(text)` as a key whose order is `BigInt`'s.
pub(super) fn order_key(text: &str) -> OrderKey {
    match js_trim(text) {
        "" => OrderKey::Small(0),
        text => parse(text).unwrap_or(OrderKey::Small(0)),
    }
}

/// What a key holds besides its struct, for the plan budget.
pub(super) fn key_bytes(key: &OrderKey) -> usize {
    match key {
        OrderKey::NegativeBig(Reverse((_, digits))) | OrderKey::PositiveBig(_, _, digits) => {
            digits.len()
        }
        OrderKey::Small(_) => 0,
    }
}
