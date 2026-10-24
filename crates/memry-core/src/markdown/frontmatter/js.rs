//! The JavaScript built-ins js-yaml and gray-matter lean on, ported for the
//! cases the frontmatter path reaches: `Number#toString`, `parseFloat`,
//! `parseInt`, `Date.UTC`, `Date#toISOString`, `Date#toString` (in UTC; the
//! oracle runs with `TZ=UTC`) and `String#trim`.

/// ECMAScript `WhiteSpace` plus `LineTerminator`: the set `\s` and `trim` use.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `Number.prototype.toString(10)`.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity" } else { "Infinity" }.to_owned();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let scientific = format!("{:e}", x.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("LowerExp always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let n = exponent.parse::<i32>().expect("a decimal exponent") + 1;
    let k = digits.len() as i32;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let tail = if k == 1 {
            String::new()
        } else {
            format!(".{}", &digits[1..])
        };
        format!(
            "{}{tail}e{}{}",
            &digits[..1],
            if e < 0 { '-' } else { '+' },
            e.abs()
        )
    };
    format!("{sign}{body}")
}

/// `parseFloat` over its longest decimal prefix. `None` is `NaN`.
pub fn parse_float(text: &str) -> f64 {
    let text = text.trim_start_matches(is_js_whitespace);
    let bytes = text.as_bytes();
    let mut at = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        at = 1;
    }
    if text[at..].starts_with("Infinity") {
        return if bytes[0] == b'-' {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let digits_start = at;
    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
    }
    let int_digits = at - digits_start;
    let mut frac_digits = 0;
    if bytes.get(at) == Some(&b'.') {
        let mut probe = at + 1;
        while bytes.get(probe).is_some_and(u8::is_ascii_digit) {
            probe += 1;
        }
        frac_digits = probe - at - 1;
        if int_digits > 0 || frac_digits > 0 {
            at = probe;
        }
    }
    if int_digits == 0 && frac_digits == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        let mut probe = at + 1;
        if matches!(bytes.get(probe), Some(b'+' | b'-')) {
            probe += 1;
        }
        let exp_start = probe;
        while bytes.get(probe).is_some_and(u8::is_ascii_digit) {
            probe += 1;
        }
        if probe > exp_start {
            at = probe;
        }
    }
    let mut normalized = text[..at].to_owned();
    if normalized.ends_with('.') {
        normalized.push('0');
    }
    let normalized = normalized.replace(".e", ".0e").replace(".E", ".0E");
    let normalized = if let Some(rest) = normalized.strip_prefix('.') {
        format!("0.{rest}")
    } else if let Some(rest) = normalized.strip_prefix("-.") {
        format!("-0.{rest}")
    } else if let Some(rest) = normalized.strip_prefix("+.") {
        format!("0.{rest}")
    } else {
        normalized
    };
    normalized.parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseInt(digits, radix)` for digit strings already validated by the caller
/// (an optional `0x` prefix is accepted for radix 16). Powers of two are exact;
/// decimal goes through the correctly rounded float parser.
pub fn parse_int(text: &str, radix: u32) -> f64 {
    let text = if radix == 16 {
        text.strip_prefix("0x")
            .or_else(|| text.strip_prefix("0X"))
            .unwrap_or(text)
    } else {
        text
    };
    let valid: String = text.chars().take_while(|c| c.is_digit(radix)).collect();
    if valid.is_empty() {
        return f64::NAN;
    }
    if radix == 10 {
        return valid.parse::<f64>().unwrap_or(f64::NAN);
    }
    let mut exact: u128 = 0;
    let mut overflowed = false;
    let mut approx = 0.0_f64;
    for c in valid.chars() {
        let digit = c.to_digit(radix).expect("filtered above");
        approx = approx * f64::from(radix) + f64::from(digit);
        match exact
            .checked_mul(u128::from(radix))
            .and_then(|v| v.checked_add(u128::from(digit)))
        {
            Some(next) if !overflowed => exact = next,
            _ => overflowed = true,
        }
    }
    if overflowed { approx } else { exact as f64 }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// `Date.UTC(year, month, day, hour, minute, second, ms)`: months and days
/// overflow into the next unit, and a year in 0..=99 means 1900 + year.
pub fn date_utc(
    year: i64,
    month0: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    ms: i64,
) -> i64 {
    let year = if (0..=99).contains(&year) {
        1900 + year
    } else {
        year
    };
    let year = year + month0.div_euclid(12);
    let month = month0.rem_euclid(12) + 1;
    let days = days_from_civil(year, month, 1) + (day - 1);
    days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + ms
}

struct Fields {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    ms: i64,
    weekday: i64,
}

fn fields(ms: i64) -> Fields {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    Fields {
        year,
        month,
        day,
        hour: rest / 3_600_000,
        minute: rest / 60_000 % 60,
        second: rest / 1000 % 60,
        ms: rest % 1000,
        weekday: (days + 4).rem_euclid(7),
    }
}

/// `Date#toISOString`.
pub fn iso_string(ms: i64) -> String {
    let f = fields(ms);
    let year = if (0..=9999).contains(&f.year) {
        format!("{:04}", f.year)
    } else {
        format!("{}{:06}", if f.year < 0 { '-' } else { '+' }, f.year.abs())
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        f.month, f.day, f.hour, f.minute, f.second, f.ms
    )
}

/// `Date#toString` with the process time zone at UTC.
pub fn date_to_string(ms: i64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let f = fields(ms);
    let year = if f.year < 0 {
        format!("-{:06}", f.year.abs())
    } else {
        format!("{:04}", f.year)
    };
    format!(
        "{} {} {:02} {year} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        DAYS[f.weekday as usize],
        MONTHS[(f.month - 1) as usize],
        f.day,
        f.hour,
        f.minute,
        f.second
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_formatting_follows_ecmascript() {
        for (value, text) in [
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.2345e-10, "1.2345e-10"),
            (0.1 + 0.2, "0.30000000000000004"),
        ] {
            assert_eq!(number_to_string(value), text);
        }
    }

    #[test]
    fn parse_float_takes_the_longest_prefix() {
        assert_eq!(parse_float("5.e3"), 5000.0);
        assert_eq!(parse_float(".5"), 0.5);
        assert_eq!(parse_float("1.5abc"), 1.5);
        assert!(parse_float("abc").is_nan());
    }

    #[test]
    fn dates_round_trip_through_civil_time() {
        assert_eq!(
            iso_string(date_utc(2024, 0, 1, 0, 0, 0, 0)),
            "2024-01-01T00:00:00.000Z"
        );
        assert_eq!(
            iso_string(date_utc(2024, 1, 31, 0, 0, 0, 0)),
            "2024-03-02T00:00:00.000Z"
        );
        assert_eq!(
            iso_string(date_utc(50, 0, 1, 0, 0, 0, 0)),
            "1950-01-01T00:00:00.000Z"
        );
    }
}
