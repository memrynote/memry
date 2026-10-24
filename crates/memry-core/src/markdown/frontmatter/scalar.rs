//! The js-yaml 3.15.1 `DEFAULT_SAFE_SCHEMA` types: tag, node kind, `resolve`
//! and `construct` (`lib/js-yaml/type/*.js`), over [`YamlValue`].

use std::sync::Arc;

use super::js::{date_utc, parse_float, parse_int};
use super::value::{YamlMap, YamlValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Scalar,
    Sequence,
    Mapping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Ty {
    Str,
    Seq,
    Map,
    Null,
    Bool,
    Int,
    Float,
    Timestamp,
    Merge,
    Binary,
    Omap,
    Pairs,
    Set,
}

/// Implicit resolution order: core schema, then timestamp and merge.
pub(super) const IMPLICIT: [Ty; 6] = [
    Ty::Null,
    Ty::Bool,
    Ty::Int,
    Ty::Float,
    Ty::Timestamp,
    Ty::Merge,
];

pub(super) const MERGE_TAG: &str = "tag:yaml.org,2002:merge";

impl Ty {
    pub(super) fn tag(self) -> &'static str {
        match self {
            Ty::Str => "tag:yaml.org,2002:str",
            Ty::Seq => "tag:yaml.org,2002:seq",
            Ty::Map => "tag:yaml.org,2002:map",
            Ty::Null => "tag:yaml.org,2002:null",
            Ty::Bool => "tag:yaml.org,2002:bool",
            Ty::Int => "tag:yaml.org,2002:int",
            Ty::Float => "tag:yaml.org,2002:float",
            Ty::Timestamp => "tag:yaml.org,2002:timestamp",
            Ty::Merge => MERGE_TAG,
            Ty::Binary => "tag:yaml.org,2002:binary",
            Ty::Omap => "tag:yaml.org,2002:omap",
            Ty::Pairs => "tag:yaml.org,2002:pairs",
            Ty::Set => "tag:yaml.org,2002:set",
        }
    }

    pub(super) fn kind(self) -> Kind {
        match self {
            Ty::Seq | Ty::Omap | Ty::Pairs => Kind::Sequence,
            Ty::Map | Ty::Set => Kind::Mapping,
            _ => Kind::Scalar,
        }
    }

    pub(super) fn from_tag(tag: &str) -> Option<Ty> {
        const ALL: [Ty; 13] = [
            Ty::Str,
            Ty::Seq,
            Ty::Map,
            Ty::Null,
            Ty::Bool,
            Ty::Int,
            Ty::Float,
            Ty::Timestamp,
            Ty::Merge,
            Ty::Binary,
            Ty::Omap,
            Ty::Pairs,
            Ty::Set,
        ];
        ALL.into_iter().find(|ty| ty.tag() == tag)
    }

    /// `type.resolve(data)`. A scalar node is always a string or `null` here.
    pub(super) fn resolve(self, data: &YamlValue) -> bool {
        let text = match data {
            YamlValue::String(text) => Some(text.as_str()),
            _ => None,
        };
        match self {
            Ty::Str | Ty::Seq | Ty::Map => true,
            Ty::Null => text.is_none_or(|t| matches!(t, "~" | "null" | "Null" | "NULL")),
            Ty::Bool => text.is_some_and(|t| {
                matches!(t, "true" | "True" | "TRUE" | "false" | "False" | "FALSE")
            }),
            Ty::Int => text.is_some_and(resolve_int),
            Ty::Float => text.is_some_and(resolve_float),
            Ty::Timestamp => text.is_some_and(|t| parse_timestamp(t).is_some()),
            Ty::Merge => text.is_none_or(|t| t == "<<"),
            Ty::Binary => text.is_some_and(resolve_binary),
            Ty::Omap => match data {
                YamlValue::Seq(items) => resolve_omap(items),
                other => *other == YamlValue::Null,
            },
            Ty::Pairs => match data {
                YamlValue::Seq(items) => items
                    .iter()
                    .all(|item| matches!(item, YamlValue::Map(map) if map.len() == 1)),
                other => *other == YamlValue::Null,
            },
            Ty::Set => match data {
                YamlValue::Map(map) => map.iter().all(|(_, value)| *value == YamlValue::Null),
                other => *other == YamlValue::Null,
            },
        }
    }

    /// `type.construct(data)`, called only after `resolve` accepted `data`.
    pub(super) fn construct(self, data: YamlValue) -> YamlValue {
        let text = match &data {
            YamlValue::String(text) => text.as_str(),
            _ => "",
        };
        match self {
            Ty::Str => match data {
                YamlValue::Null => YamlValue::String(String::new()),
                other => other,
            },
            Ty::Seq | Ty::Omap => match data {
                YamlValue::Null => YamlValue::seq(Vec::new()),
                other => other,
            },
            Ty::Map | Ty::Set => match data {
                YamlValue::Null => YamlValue::map(YamlMap::new()),
                other => other,
            },
            Ty::Null => YamlValue::Null,
            Ty::Bool => YamlValue::Bool(matches!(text, "true" | "True" | "TRUE")),
            Ty::Int => YamlValue::Number(construct_int(text)),
            Ty::Float => YamlValue::Number(construct_float(text)),
            Ty::Timestamp => YamlValue::Date(parse_timestamp(text).expect("resolved first")),
            Ty::Merge => data,
            Ty::Binary => YamlValue::Binary(Arc::new(construct_binary(text))),
            Ty::Pairs => match &data {
                YamlValue::Seq(items) => YamlValue::seq(
                    items
                        .iter()
                        .map(|item| match item {
                            YamlValue::Map(map) => {
                                let (key, value) = map.iter().next().expect("one key");
                                YamlValue::seq(vec![
                                    YamlValue::String(key.to_owned()),
                                    value.clone(),
                                ])
                            }
                            other => other.clone(),
                        })
                        .collect(),
                ),
                _ => YamlValue::seq(Vec::new()),
            },
        }
    }
}

fn resolve_omap(items: &[YamlValue]) -> bool {
    let mut seen: Vec<&str> = Vec::new();
    for item in items {
        let YamlValue::Map(map) = item else {
            return false;
        };
        let mut keys = map.iter();
        let Some((key, _)) = keys.next() else {
            return false;
        };
        if keys.next().is_some() || seen.contains(&key) {
            return false;
        }
        seen.push(key);
    }
    true
}

fn resolve_int(data: &str) -> bool {
    let chars: Vec<char> = data.chars().collect();
    let max = chars.len();
    if max == 0 {
        return false;
    }
    let mut index = 0;
    let mut has_digits = false;
    let mut ch = chars[index];
    if ch == '-' || ch == '+' {
        index += 1;
        ch = chars.get(index).copied().unwrap_or('\0');
    }
    if ch == '0' {
        if index + 1 == max {
            return true;
        }
        index += 1;
        ch = chars[index];
        let scan = |from: usize, ok: fn(char) -> bool| {
            let mut has = false;
            let mut last = '\0';
            for &c in &chars[from..] {
                last = c;
                if c == '_' {
                    continue;
                }
                if !ok(c) {
                    return false;
                }
                has = true;
            }
            has && last != '_'
        };
        return match ch {
            'b' => scan(index + 1, |c| c == '0' || c == '1'),
            'x' => scan(index + 1, |c| c.is_ascii_hexdigit()),
            _ => scan(index, |c| ('0'..='7').contains(&c)),
        };
    }
    if ch == '_' {
        return false;
    }
    while index < max {
        ch = chars[index];
        if ch == '_' {
            index += 1;
            continue;
        }
        if ch == ':' {
            break;
        }
        if !ch.is_ascii_digit() {
            return false;
        }
        has_digits = true;
        index += 1;
    }
    if !has_digits || ch == '_' {
        return false;
    }
    if ch != ':' {
        return true;
    }
    // `^(:[0-5]?[0-9])+$` over the rest.
    let rest = &chars[index..];
    let mut at = 0;
    if rest.is_empty() {
        return false;
    }
    while at < rest.len() {
        if rest[at] != ':' {
            return false;
        }
        at += 1;
        match (rest.get(at), rest.get(at + 1)) {
            (Some(a), Some(b)) if ('0'..='5').contains(a) && b.is_ascii_digit() => at += 2,
            (Some(a), _) if a.is_ascii_digit() => at += 1,
            _ => return false,
        }
    }
    true
}

fn construct_int(data: &str) -> f64 {
    let mut value: String = data.chars().filter(|c| *c != '_').collect();
    let mut sign = 1.0;
    if let Some(first @ ('-' | '+')) = value.chars().next() {
        if first == '-' {
            sign = -1.0;
        }
        value.remove(0);
    }
    if value == "0" {
        return 0.0;
    }
    if value.starts_with('0') {
        if let Some(rest) = value.strip_prefix("0b") {
            return sign * parse_int(rest, 2);
        }
        if value.starts_with("0x") {
            return sign * parse_int(&value, 16);
        }
        return sign * parse_int(&value, 8);
    }
    if value.contains(':') {
        let mut total = 0.0;
        let mut base = 1.0;
        for part in value.split(':').rev() {
            total += parse_int(part, 10) * base;
            base *= 60.0;
        }
        return sign * total;
    }
    sign * parse_int(&value, 10)
}

/// `YAML_FLOAT_PATTERN`, matched without a regex engine.
fn resolve_float(data: &str) -> bool {
    if data.ends_with('_') {
        return false;
    }
    let b = data.as_bytes();
    let digit_or_us = |c: &u8| c.is_ascii_digit() || *c == b'_';
    let skip = |from: usize, pred: &dyn Fn(&u8) -> bool| {
        let mut at = from;
        while b.get(at).is_some_and(pred) {
            at += 1;
        }
        at
    };
    let exponent = |from: usize| -> Option<usize> {
        if !matches!(b.get(from), Some(b'e' | b'E')) {
            return Some(from);
        }
        let mut at = from + 1;
        if matches!(b.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let end = skip(at, &|c: &u8| c.is_ascii_digit());
        (end > at).then_some(end)
    };
    let signed = usize::from(matches!(b.first(), Some(b'+' | b'-')));

    // 2.5e4, 2.5 and integers
    'plain: {
        let mut at = signed;
        match b.get(at) {
            Some(b'0') => at += 1,
            Some(c) if (b'1'..=b'9').contains(c) => at = skip(at + 1, &digit_or_us),
            _ => break 'plain,
        }
        if b.get(at) == Some(&b'.') {
            at = skip(at + 1, &digit_or_us);
        }
        if exponent(at) == Some(b.len()) {
            return true;
        }
    }
    // .2e4, .2
    if b.first() == Some(&b'.') {
        let at = skip(1, &digit_or_us);
        if at > 1 && exponent(at) == Some(b.len()) {
            return true;
        }
    }
    // 20:59.5
    'sexagesimal: {
        let mut at = signed;
        if !b.get(at).is_some_and(u8::is_ascii_digit) {
            break 'sexagesimal;
        }
        at = skip(at + 1, &digit_or_us);
        let mut groups = 0;
        while b.get(at) == Some(&b':') {
            at += 1;
            match (b.get(at), b.get(at + 1)) {
                (Some(x), Some(y)) if (b'0'..=b'5').contains(x) && y.is_ascii_digit() => at += 2,
                (Some(x), _) if x.is_ascii_digit() => at += 1,
                _ => break 'sexagesimal,
            }
            groups += 1;
        }
        if groups > 0 && b.get(at) == Some(&b'.') && skip(at + 1, &digit_or_us) == b.len() {
            return true;
        }
    }
    let unsigned = &data[signed..];
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") {
        return true;
    }
    signed == 0 && matches!(data, ".nan" | ".NaN" | ".NAN")
}

fn construct_float(data: &str) -> f64 {
    let value: String = data
        .chars()
        .filter(|c| *c != '_')
        .collect::<String>()
        .to_lowercase();
    let sign = if value.starts_with('-') { -1.0 } else { 1.0 };
    let value = value.strip_prefix(['+', '-']).unwrap_or(&value);
    if value == ".inf" {
        return sign * f64::INFINITY;
    }
    if value == ".nan" {
        return f64::NAN;
    }
    if value.contains(':') {
        let mut total = 0.0;
        let mut base = 1.0;
        for part in value.split(':').rev() {
            total += parse_float(part) * base;
            base *= 60.0;
        }
        return sign * total;
    }
    sign * parse_float(value)
}

/// `YAML_DATE_REGEXP` and `YAML_TIMESTAMP_REGEXP`, then `constructYamlTimestamp`.
fn parse_timestamp(data: &str) -> Option<i64> {
    let b = data.as_bytes();
    let number =
        |from: usize, to: usize| -> i64 { data[from..to].parse::<i64>().expect("ascii digits") };
    let digits = |from: usize, min: usize, max: usize| -> Option<usize> {
        let mut at = from;
        while at - from < max && b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        (at - from >= min).then_some(at)
    };
    if b.len() < 10 || !b[..4].iter().all(u8::is_ascii_digit) || b[4] != b'-' {
        return None;
    }
    let year = number(0, 4);
    let month_end = digits(5, 1, 2)?;
    if b.get(month_end) != Some(&b'-') {
        return None;
    }
    let month = number(5, month_end) - 1;
    let day_end = digits(month_end + 1, 1, 2)?;
    let day = number(month_end + 1, day_end);
    if day_end == b.len() {
        // The date-only form needs two digits each.
        return (month_end == 7 && day_end == 10).then(|| date_utc(year, month, day, 0, 0, 0, 0));
    }
    // (?:[Tt]|[ \t]+)
    let mut at = day_end;
    if matches!(b[at], b'T' | b't') {
        at += 1;
    } else if matches!(b[at], b' ' | b'\t') {
        while matches!(b.get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
    } else {
        return None;
    }
    let hour_end = digits(at, 1, 2)?;
    let hour = number(at, hour_end);
    if b.get(hour_end) != Some(&b':') {
        return None;
    }
    let minute_end = digits(hour_end + 1, 2, 2)?;
    let minute = number(hour_end + 1, minute_end);
    if b.get(minute_end) != Some(&b':') {
        return None;
    }
    let second_end = digits(minute_end + 1, 2, 2)?;
    let second = number(minute_end + 1, second_end);
    let mut at = second_end;
    let mut fraction = 0;
    if b.get(at) == Some(&b'.') {
        let end = digits(at + 1, 0, usize::MAX)?;
        let mut text: String = data[at + 1..end].chars().take(3).collect();
        while text.len() < 3 {
            text.push('0');
        }
        fraction = text.parse::<i64>().expect("ascii digits");
        at = end;
    }
    let mut delta: Option<i64> = None;
    if at < b.len() {
        let mut probe = at;
        while matches!(b.get(probe), Some(b' ' | b'\t')) {
            probe += 1;
        }
        match b.get(probe) {
            Some(b'Z') if probe + 1 == b.len() => {}
            Some(sign @ (b'-' | b'+')) => {
                let hour_end = digits(probe + 1, 1, 2)?;
                let tz_hour = number(probe + 1, hour_end);
                let mut tz_minute = 0;
                let mut end = hour_end;
                if b.get(hour_end) == Some(&b':') {
                    end = digits(hour_end + 1, 2, 2)?;
                    tz_minute = number(hour_end + 1, end);
                }
                if end != b.len() {
                    return None;
                }
                let total = (tz_hour * 60 + tz_minute) * 60_000;
                delta = Some(if *sign == b'-' { -total } else { total });
            }
            _ => return None,
        }
    }
    let ms = date_utc(year, month, day, hour, minute, second, fraction);
    Some(match delta {
        Some(delta) if delta != 0 => ms - delta,
        _ => ms,
    })
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn resolve_binary(data: &str) -> bool {
    let mut bits = 0;
    for c in data.chars() {
        if c == '\n' || c == '\r' {
            continue;
        }
        if !c.is_ascii() || !(c == '=' || BASE64.contains(&(c as u8))) {
            return false;
        }
        bits += 6;
    }
    bits % 8 == 0
}

fn construct_binary(data: &str) -> Vec<u8> {
    let input: Vec<u8> = data
        .bytes()
        .filter(|c| !matches!(c, b'\r' | b'\n' | b'='))
        .map(|c| BASE64.iter().position(|b| *b == c).expect("resolved") as u8)
        .collect();
    let mut out = Vec::new();
    let mut bits: u32 = 0;
    for (idx, value) in input.iter().enumerate() {
        if idx % 4 == 0 && idx > 0 {
            out.extend([(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
        }
        bits = (bits << 6) | u32::from(*value);
    }
    match (input.len() % 4) * 6 {
        0 => out.extend([(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]),
        18 => out.extend([(bits >> 10) as u8, (bits >> 2) as u8]),
        12 => out.push((bits >> 4) as u8),
        _ => {}
    }
    out
}

/// `representYamlBinary`: base64 with padding.
pub(super) fn represent_binary(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        // The original always writes a final group, even for no bytes.
        return "AAAA".to_owned();
    }
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(BASE64[((n >> (18 - 6 * i)) & 0x3F) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
