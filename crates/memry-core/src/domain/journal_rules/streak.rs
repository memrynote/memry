//! The journal streak: consecutive days with an entry.
//!
//! Mirrors `domain-notes/src/journal/streak.ts`. The caller supplies `today`
//! as a `YYYY-MM-DD` calendar key (desktop its UTC date, the phone its local
//! date, spec 005-journal D3); day arithmetic runs on calendar keys, so no
//! time zone can shift a day.

use std::collections::BTreeSet;

use crate::domain::calendar::CivilDate;

#[derive(Debug, Clone, PartialEq)]
pub struct JournalStreak {
    pub current_streak: u32,
    pub longest_streak: u32,
    pub last_entry_date: Option<String>,
}

/// `addDaysToKey`: `date_key` moved by `delta` calendar days. `None` for a
/// key that is not a real `YYYY-MM-DD` date (JS throws on the invalid `Date`).
pub fn add_days_to_key(date_key: &str, delta: i64) -> Option<String> {
    CivilDate::parse_key(date_key).map(|date| date.add_days(delta).key())
}

/// `computeJournalStreak`: current and longest runs over a set of entry dates.
///
/// The current run counts back from `today` when today has an entry, otherwise
/// from yesterday when yesterday has one, otherwise it is 0. The longest run is
/// the longest chain of consecutive dates anywhere in the set.
pub fn compute_journal_streak<S: AsRef<str>>(dates: &[S], today: &str) -> JournalStreak {
    let set: BTreeSet<&str> = dates.iter().map(AsRef::as_ref).collect();
    // `BTreeSet` iterates in code-unit order for these ASCII keys, as `sort()` does.
    let Some(last_entry_date) = set.last() else {
        return JournalStreak {
            current_streak: 0,
            longest_streak: 0,
            last_entry_date: None,
        };
    };

    let start = if set.contains(today) {
        Some(today.to_owned())
    } else {
        add_days_to_key(today, -1).filter(|yesterday| set.contains(yesterday.as_str()))
    };
    let mut current_streak = 0;
    let mut cursor = start;
    while let Some(day) = cursor.filter(|day| set.contains(day.as_str())) {
        current_streak += 1;
        cursor = add_days_to_key(&day, -1);
    }

    let mut longest_streak = 0;
    let mut run = 0;
    let mut previous: Option<Option<i64>> = None;
    for date in &set {
        let day = CivilDate::parse_key(date).map(CivilDate::days_since_epoch);
        run = match (previous, day) {
            (Some(Some(before)), Some(now)) if now - before == 1 => run + 1,
            _ => 1,
        };
        longest_streak = longest_streak.max(run);
        previous = Some(day);
    }

    JournalStreak {
        current_streak,
        longest_streak,
        last_entry_date: Some((*last_entry_date).to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_days_crosses_leap_day_and_year_end() {
        assert_eq!(
            add_days_to_key("2096-03-01", -1).as_deref(),
            Some("2096-02-29")
        );
        assert_eq!(
            add_days_to_key("2099-01-01", -1).as_deref(),
            Some("2098-12-31")
        );
        assert_eq!(add_days_to_key("not-a-date", -1), None);
    }

    #[test]
    fn invalid_keys_break_runs() {
        let dates = ["2099-06-14", "junk", "2099-06-15"];
        let streak = compute_journal_streak(&dates, "2099-06-15");
        assert_eq!(streak.current_streak, 2);
        assert_eq!(streak.longest_streak, 2);
        assert_eq!(streak.last_entry_date.as_deref(), Some("junk"));
    }
}
