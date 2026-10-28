//! The public form of an app version (`apps/desktop/src/main/lib/app-version-display.ts`).
//! Releases are versioned `YYYY.MDD.N` so they sort as SemVer; users see `vYYYY-MM-DD[.N]`.

use std::sync::LazyLock;

use regex::Regex;

static APP_VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4})\.(\d{3,4})\.(\d+)$").expect("static pattern"));

/// `2026.506.1` is `v2026-05-06`, `2026.1101.3` is `v2026-11-01.3`. Anything that is not a
/// release version of a real calendar day comes back unchanged.
pub fn format_app_version_for_display(version: &str) -> String {
    let Some(caps) = APP_VERSION.captures(version) else {
        return version.to_owned();
    };
    let (year_text, month_day) = (&caps[1], &caps[2]);
    let index = display_index(&caps[3]);
    if index == "0" {
        return version.to_owned();
    }
    let split = if month_day.len() == 3 { 1 } else { 2 };
    let (Ok(month), Ok(day), Ok(year)) = (
        month_day[..split].parse::<u32>(),
        month_day[split..].parse::<u32>(),
        year_text.parse::<i32>(),
    ) else {
        return version.to_owned();
    };
    if !is_valid_date(year, month, day) {
        return version.to_owned();
    }
    let suffix = match index {
        "1" => String::new(),
        _ => format!(".{index}"),
    };
    format!("v{year_text}-{month:02}-{day:02}{suffix}")
}

/// The release index as `String(Number(text))` prints it: no leading zeros.
fn display_index(text: &str) -> &str {
    let trimmed = text.trim_start_matches('0');
    if trimmed.is_empty() { "0" } else { trimmed }
}

fn is_valid_date(year: i32, month: u32, day: u32) -> bool {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

#[cfg(test)]
mod tests {
    use super::format_app_version_for_display as display;

    #[test]
    fn formats_semver_safe_release_versions_as_public_date_versions() {
        assert_eq!(display("2026.506.1"), "v2026-05-06");
        assert_eq!(display("2026.506.2"), "v2026-05-06.2");
        assert_eq!(display("2026.1101.3"), "v2026-11-01.3");
    }

    #[test]
    fn falls_back_to_the_raw_value_for_unknown_or_invalid_versions() {
        assert_eq!(display("1.0.0"), "1.0.0");
        assert_eq!(display("v2026-05-06"), "v2026-05-06");
        assert_eq!(display("2026.132.1"), "2026.132.1");
    }

    #[test]
    fn rejects_index_zero_and_impossible_days_like_the_utc_date_check() {
        assert_eq!(display("2026.506.0"), "2026.506.0");
        assert_eq!(display("2026.229.1"), "2026.229.1");
        assert_eq!(display("2028.229.1"), "v2028-02-29");
        assert_eq!(display("2026.1301.1"), "2026.1301.1");
        assert_eq!(display("2026.1000.1"), "2026.1000.1");
    }

    #[test]
    fn prints_the_index_without_leading_zeros_as_number_does() {
        assert_eq!(display("2026.506.01"), "v2026-05-06");
        assert_eq!(display("2026.506.007"), "v2026-05-06.7");
    }
}
