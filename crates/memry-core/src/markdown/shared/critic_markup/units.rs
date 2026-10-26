//! JavaScript string semantics over UTF-16 code units: `slice`, `indexOf` and
//! `length`. Offsets in CriticMarkup marks are code-unit offsets, and a slice
//! may cut a surrogate pair, so text is carried as units and only converted
//! back (lossily, never panicking) at the end.

pub fn to_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub fn from_units(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `String.prototype.length`.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `Array.prototype.slice` bounds applied to `units`.
pub fn slice_units(units: &[u16], start: i64, end: i64) -> &[u16] {
    let len = units.len() as i64;
    let clamp = |index: i64| {
        if index < 0 {
            (len + index).max(0)
        } else {
            index.min(len)
        }
    };
    let (from, to) = (clamp(start), clamp(end));
    if from >= to {
        &[]
    } else {
        &units[from as usize..to as usize]
    }
}

/// `String.prototype.indexOf`, in code units.
pub fn index_of_units(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
