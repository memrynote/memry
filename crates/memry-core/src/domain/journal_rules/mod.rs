//! The journal rules desktop and the iOS core must agree on (spec
//! 005-journal D4): preview, word count, activity level, streak, month and
//! year arithmetic, template resolution and substitution.
//!
//! Mirrors `packages/domain-notes/src/journal/*` and `countWords` /
//! `calculateActivityLevel` of `packages/contracts/src/journal-api.ts`, held
//! to them by `packages/contracts/test-vectors/journal.json`. Pure functions:
//! no storage, no clock (`today` is a `YYYY-MM-DD` argument), no locale (the
//! shell formats long dates, times and weekday names). Lengths are JavaScript
//! string lengths, UTF-16 code units.

pub mod preview;
pub mod stats;
pub mod streak;
pub mod templates;

pub use preview::{JOURNAL_PREVIEW_LENGTH, extract_journal_preview};
pub use stats::{
    JournalDayCounts, JournalHeatmapDay, JournalMonthActivity, JournalMonthDay,
    JournalYearMonthStats, average_activity_level, days_in_month, heatmap_day, month_activity,
    month_days, year_month_stats,
};
pub use streak::{JournalStreak, add_days_to_key, compute_journal_streak};
pub use templates::{
    AppliedJournalTemplate, JournalTemplateFormatted, JournalTemplateProperty,
    JournalTemplateSettings, JournalTemplateSource, apply_journal_template, format_date_pattern,
    ordered_weekdays, resolve_journal_template_id, weekday_of,
};

/// A 0-4 heat level (`ActivityLevel` in `journal-api.ts`).
pub type ActivityLevel = u8;

/// JavaScript's `\s` and `String.prototype.trim` set: WhiteSpace plus
/// LineTerminator. Differs from [`char::is_whitespace`] on U+0085 (not in the
/// JS set) and U+FEFF (in it).
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `string.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `countWords` (`journal-api.ts`): `trim().split(/\s+/)`, empty pieces dropped.
pub fn count_words(text: &str) -> usize {
    js_trim(text)
        .split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .count()
}

/// `calculateActivityLevel` (`journal-api.ts`): 0 → 0, ≤100 → 1, ≤500 → 2,
/// ≤1000 → 3, else 4.
pub fn calculate_activity_level(character_count: u64) -> ActivityLevel {
    match character_count {
        0 => 0,
        1..=100 => 1,
        101..=500 => 2,
        501..=1000 => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_whitespace_differs_from_unicode_on_nel_and_bom() {
        assert!(!is_js_whitespace('\u{0085}'));
        assert!(is_js_whitespace('\u{FEFF}'));
        assert_eq!(count_words("\u{FEFF}a\u{0085}b c "), 2);
    }

    #[test]
    fn activity_level_boundaries() {
        let levels: Vec<_> = [0, 1, 100, 101, 500, 501, 1000, 1001]
            .into_iter()
            .map(calculate_activity_level)
            .collect();
        assert_eq!(levels, [0, 1, 1, 2, 2, 3, 3, 4]);
    }
}
