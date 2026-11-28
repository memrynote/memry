//! A `((date:…))` payload (`packages/shared/src/date-mention.ts`).

use base64::Engine as _;
use base64::alphabet::STANDARD;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use serde_json::{Map, Value};

use super::{DateMention, Fate, InlineToken};

const REMIND_OFFSETS: [&str; 11] = [
    "none", "at", "5m", "10m", "15m", "30m", "1h", "2h", "1d", "2d", "1w",
];

/// `atob`: trailing bits are discarded, and a length of one more than a
/// multiple of four is refused.
const ATOB: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// `parseDateMentionToken`, else `salvageDateMentionToken`.
pub(super) fn fate(encoded: &str) -> Fate {
    let object = match decode_object(encoded) {
        Decoded::Object(object) => object,
        Decoded::Refused => return Fate::Text,
        Decoded::Undecided => return Fate::Undecided,
    };
    if let Some(date) = parse(&object) {
        return Fate::Node(InlineToken::Date(date));
    }
    salvage(&object)
}

enum Decoded {
    Object(Map<String, Value>),
    Refused,
    Undecided,
}

/// `decodeTokenObject`: `JSON.parse(atob(…))` of the payload in either
/// alphabet, with any `\` dropped. `atob` gives one character per byte, so
/// the bytes are read as Latin-1, not UTF-8. `isObject` admits an array,
/// whose fields are all missing.
fn decode_object(encoded: &str) -> Decoded {
    let base64: String = encoded
        .chars()
        .filter(|c| *c != '\\')
        .map(|c| match c {
            '-' | ',' => '+',
            '_' | ';' => '/',
            other => other,
        })
        .collect();
    let Ok(bytes) = ATOB.decode(base64) else {
        return Decoded::Refused;
    };
    let text: String = bytes.iter().map(|byte| char::from(*byte)).collect();
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => Decoded::Object(object),
        Ok(Value::Array(_)) => Decoded::Object(Map::new()),
        Ok(_) => Decoded::Refused,
        // `JSON.parse` takes a lone surrogate escape, which serde refuses.
        Err(_) if text.contains("\\u") => Decoded::Undecided,
        Err(_) => Decoded::Refused,
    }
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

/// The cosmetic fields, defaulted so a slightly old token still renders.
fn formats(object: &Map<String, Value>) -> (String, String) {
    let date_format = if string(object, "dateFormat") == Some("full") {
        "full"
    } else {
        "relative"
    };
    let time_format = string(object, "timeFormat")
        .filter(|format| matches!(*format, "12h" | "24h"))
        .unwrap_or("system");
    (date_format.to_owned(), time_format.to_owned())
}

/// `parseDateMentionToken`: strict on the load-bearing fields.
fn parse(object: &Map<String, Value>) -> Option<DateMention> {
    let anchor_id = string(object, "anchorId")?;
    let date_iso = string(object, "dateISO")?;
    let has_time = object.get("hasTime").and_then(Value::as_bool)?;
    let remind = string(object, "remind").filter(|remind| REMIND_OFFSETS.contains(remind))?;
    let (date_format, time_format) = formats(object);
    Some(DateMention {
        anchor_id: anchor_id.to_owned(),
        date_iso: date_iso.to_owned(),
        has_time,
        date_format,
        remind: remind.to_owned(),
        time_format,
    })
}

/// `salvageDateMentionToken`: a token the strict parse refused keeps its date
/// when it has an anchor and a date `Date.parse` reads, with no reminder.
fn salvage(object: &Map<String, Value>) -> Fate {
    let Some(anchor_id) = string(object, "anchorId").filter(|id| !id.is_empty()) else {
        return Fate::Text;
    };
    let Some(date_iso) = string(object, "dateISO") else {
        return Fate::Text;
    };
    match js_date_parses(date_iso) {
        Some(true) => {}
        Some(false) => return Fate::Text,
        None => return Fate::Undecided,
    }
    let (date_format, time_format) = formats(object);
    Fate::Node(InlineToken::Date(DateMention {
        anchor_id: anchor_id.to_owned(),
        date_iso: date_iso.to_owned(),
        has_time: object.get("hasTime") == Some(&Value::Bool(true)),
        date_format,
        remind: "none".to_owned(),
        time_format,
    }))
}

/// Whether V8's `Date.parse` reads `value` as a date, for the ECMAScript
/// date-time string format (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, each optionally
/// with `THH:mm`, `:ss`, `.sss` and `Z` or `±HH:mm`), which is what
/// `toISOString` writes. `Some(false)` for a string no V8 parser reads: empty,
/// or that format with a field out of range. `None` for anything else, which
/// V8's legacy fallback parser may or may not read.
fn js_date_parses(value: &str) -> Option<bool> {
    if value.is_empty() {
        return Some(false);
    }
    let bytes = value.as_bytes();
    let number = |from: usize, len: usize| -> Option<u32> {
        let digits = bytes.get(from..from + len)?;
        digits
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| std::str::from_utf8(digits).ok()?.parse().ok())
            .flatten()
    };
    number(0, 4)?;
    let mut at = 4;
    let mut fields = Vec::new();
    for _ in 0..2 {
        if bytes.get(at) != Some(&b'-') {
            break;
        }
        fields.push(number(at + 1, 2)?);
        at += 3;
    }
    if fields
        .first()
        .is_some_and(|month| !(1..=12).contains(month))
        || fields.get(1).is_some_and(|day| !(1..=31).contains(day))
    {
        return Some(false);
    }
    if at == bytes.len() {
        return Some(true);
    }
    if bytes.get(at) != Some(&b'T') || fields.len() < 2 {
        return None;
    }
    let hours = number(at + 1, 2)?;
    if bytes.get(at + 3) != Some(&b':') {
        return None;
    }
    let minutes = number(at + 4, 2)?;
    at += 6;
    let mut seconds = 0;
    let mut fraction_zero = true;
    if bytes.get(at) == Some(&b':') {
        seconds = number(at + 1, 2)?;
        at += 3;
        if bytes.get(at) == Some(&b'.') {
            let digits = bytes[at + 1..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
            if digits == 0 {
                return None;
            }
            fraction_zero = bytes[at + 1..at + 1 + digits].iter().all(|b| *b == b'0');
            at += 1 + digits;
        }
    }
    match &bytes[at..] {
        [] | [b'Z'] => {}
        [b'+' | b'-', ..] => {
            let offset_hours = number(at + 1, 2)?;
            if bytes.get(at + 3) != Some(&b':') || bytes.len() != at + 6 {
                return None;
            }
            let offset_minutes = number(at + 4, 2)?;
            if offset_hours > 23 || offset_minutes > 59 {
                return Some(false);
            }
        }
        _ => return None,
    }
    let midnight_after = hours == 24 && minutes == 0 && seconds == 0 && fraction_zero;
    Some((hours < 24 || midnight_after) && minutes < 60 && seconds < 60)
}

#[cfg(test)]
mod tests {
    use super::js_date_parses;

    #[test]
    fn the_iso_format_reads_as_v8_reads_it() {
        for (value, parses) in [
            ("2026-02-30", Some(true)),
            ("2026-13-01", Some(false)),
            ("2026", Some(true)),
            ("2026-01", Some(true)),
            ("2026-01-01T10:00Z", Some(true)),
            ("2026-01-01T24:00", Some(true)),
            ("2026-01-01T24:00:01", Some(false)),
            ("2026-01-01T25:00", Some(false)),
            ("2026-01-31T10:00:60Z", Some(false)),
            ("2026-08-14T09:00:00.000Z", Some(true)),
            ("2026-01-01T10:00:00.1234+02:00", Some(true)),
            ("", Some(false)),
            ("2026-1-1", None),
            ("Jan 1 2026", None),
            ("2026-01-01 10:00", None),
        ] {
            assert_eq!(js_date_parses(value), parses, "{value}");
        }
    }
}
