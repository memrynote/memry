//! The writer version floor (#1396), ported from desktop's
//! `apps/desktop/src/main/calendar/provider/writer-compat.ts`.
//!
//! Sync payloads are end-to-end encrypted and `provider` sits inside them, so
//! the server cannot keep a CalDAV binding away from an older build. An older
//! build with Google connected treats that binding as absent and pushes the
//! same task to Google, or reads a CalDAV collection URL as a Google calendar
//! id. Only the connect flow can prevent that: before a second writable
//! provider connects, it lists the account's devices below the floor.

use super::projection_sources::provider_supports_write;

/// `CALENDAR_MULTI_WRITER_MIN_APP_VERSION` (`packages/contracts/src/calendar-api.ts`).
pub const CALENDAR_MULTI_WRITER_MIN_APP_VERSION: &str = "2026.925.0";

/// Clients that never write to an external calendar, so no version of them
/// can double push. iOS registers a semver (`0.1.0`) that would always read
/// as below the floor. Any other platform string is checked (fail closed).
pub const NON_WRITER_PLATFORMS: [&str; 3] = ["ios", "android", "web"];

/// `providerNeedsWriterCompatCheck`: connecting this provider adds a second
/// writer to the account.
pub fn provider_needs_writer_compat_check(provider: &str) -> bool {
    provider != "google" && provider_supports_write(provider)
}

/// Whether another device of the account is an outdated writer: a platform
/// that writes, with no version or one below the floor. The caller leaves out
/// the current device.
pub fn is_outdated_writer(platform: &str, app_version: Option<&str>) -> bool {
    !NON_WRITER_PLATFORMS.contains(&platform)
        && app_version
            .is_none_or(|v| is_app_version_below(v, CALENDAR_MULTI_WRITER_MIN_APP_VERSION))
}

/// `isAppVersionBelow`: numeric major.minor.patch, as the sync server orders
/// versions. Each part is JavaScript's `Number(part)` (an empty part is 0),
/// parts past the patch are ignored, and a version part that is not a finite
/// number reads as below.
pub fn is_app_version_below(version: &str, minimum: &str) -> bool {
    let a = triple(version);
    let b = triple(minimum);
    if a.iter().any(|part| !part.is_finite()) {
        return true;
    }
    for (left, right) in a.iter().zip(b) {
        if *left != right {
            return *left < right;
        }
    }
    false
}

fn triple(version: &str) -> [f64; 3] {
    let mut parts = version.split('.').map(js_number);
    let mut out = [0.0; 3];
    for slot in &mut out {
        // `const [a, b = 0, c = 0]`: a missing part defaults, NaN stays NaN.
        if let Some(part) = parts.next() {
            *slot = part;
        }
    }
    out
}

/// ECMAScript `StringToNumber` for text with no `.` in it.
fn js_number(text: &str) -> f64 {
    // StrWhiteSpaceChar: Unicode White_Space without U+0085, plus U+FEFF.
    let text = text.trim_matches(|c: char| c == '\u{FEFF}' || (c.is_whitespace() && c != '\u{85}'));
    if text.is_empty() {
        return 0.0;
    }
    let radix = match text.get(..2) {
        Some("0x" | "0X") => 16,
        Some("0o" | "0O") => 8,
        Some("0b" | "0B") => 2,
        _ => 10,
    };
    if radix != 10 {
        let digits = &text[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        return digits
            .chars()
            .try_fold(0.0, |acc: f64, c| {
                c.to_digit(radix)
                    .map(|d| acc * f64::from(radix) + f64::from(d))
            })
            .unwrap_or(f64::NAN);
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Digits with an optional exponent; Rust's parser alone would also take
    // `inf`, `nan` and other spellings JavaScript refuses.
    let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e.strip_prefix(['+', '-']).unwrap_or(e))),
        None => (unsigned, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(mantissa) || exponent.is_some_and(|e| !digits(e)) {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_release_versions_numerically_like_the_sync_server() {
        assert!(is_app_version_below("2026.919.1", "2026.925.0"));
        assert!(!is_app_version_below("2026.1002.1", "2026.925.0"));
        assert!(!is_app_version_below("2026.925.0", "2026.925.0"));
        assert!(is_app_version_below(
            "1.0.0",
            CALENDAR_MULTI_WRITER_MIN_APP_VERSION
        ));
        assert!(is_app_version_below(
            "garbage",
            CALENDAR_MULTI_WRITER_MIN_APP_VERSION
        ));
    }

    #[test]
    fn reads_each_part_as_javascript_number_does() {
        let cases = [
            (" 2026 ", 2026.0),
            ("\u{FEFF}7", 7.0),
            ("0x7EA", 2026.0),
            ("0b11", 3.0),
            ("0o17", 15.0),
            ("+5", 5.0),
            ("-5", -5.0),
            ("1e3", 1000.0),
            ("2E+2", 200.0),
        ];
        for (text, want) in cases {
            assert_eq!(js_number(text), want, "{text:?}");
        }
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        for text in [
            "\u{85}1", "inf", "NaN", "infinity", "0x", "-0x1", "1e", "1_0", "0-beta", "x",
        ] {
            assert!(js_number(text).is_nan(), "{text:?}");
        }
    }

    #[test]
    fn only_providers_that_add_a_second_writer_are_checked() {
        assert!(!provider_needs_writer_compat_check("google"));
        assert!(!provider_needs_writer_compat_check("ics"));
        assert!(!provider_needs_writer_compat_check("unknown"));
        assert!(provider_needs_writer_compat_check("caldav"));
    }

    #[test]
    fn lists_writers_below_the_floor_or_with_no_version_and_skips_phones_and_web() {
        assert!(is_outdated_writer("windows", Some("2026.919.1")));
        assert!(!is_outdated_writer("windows", Some("2026.1002.1")));
        assert!(is_outdated_writer("linux", None));
        assert!(is_outdated_writer("macos", Some("")));
        assert!(!is_outdated_writer("ios", Some("0.1.0")));
        assert!(!is_outdated_writer("android", None));
        assert!(!is_outdated_writer("web", Some("1.0.0")));
        // An unknown platform is checked.
        assert!(is_outdated_writer("tvos", Some("0.1.0")));
    }

    proptest::proptest! {
        #![proptest_config(memry_test_kit::proptest_config(memry_test_kit::DEFAULT_CASES))]

        #[test]
        fn numeric_versions_compare_as_triples(
            a in proptest::array::uniform3(0u32..3000),
            b in proptest::array::uniform3(0u32..3000),
        ) {
            let text = |t: [u32; 3]| format!("{}.{}.{}", t[0], t[1], t[2]);
            proptest::prop_assert_eq!(is_app_version_below(&text(a), &text(b)), a < b);
        }

        #[test]
        fn any_version_text_reads_without_panicking(version in ".{0,40}") {
            let _ = is_app_version_below(&version, CALENDAR_MULTI_WRITER_MIN_APP_VERSION);
        }
    }
}
