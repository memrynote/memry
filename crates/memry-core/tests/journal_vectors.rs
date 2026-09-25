//! The `journal` class (spec 005-journal D3, D4, D6, JP012): every case of
//! every section of `journal.json` against `domain::journal_rules`. The
//! committed JSON is the only input.

mod support;

use std::collections::BTreeMap;

use memry_core::domain::journal_rules::{
    self, JournalDayCounts, JournalHeatmapDay, JournalTemplateFormatted, JournalTemplateProperty,
    JournalTemplateSettings, JournalTemplateSource,
};
use serde_json::{Value as Json, json};
use support::{str_field, vector_file};

/// The section's cases; fails when the section is missing or empty.
fn section(name: &str) -> Vec<Json> {
    let cases = vector_file("journal")[name]
        .as_array()
        .unwrap_or_else(|| panic!("journal.json has no `{name}` array"))
        .clone();
    assert!(!cases.is_empty(), "journal.json section `{name}` is empty");
    cases
}

fn uint(value: &Json) -> u64 {
    value
        .as_u64()
        .unwrap_or_else(|| panic!("not a non-negative integer: {value}"))
}

fn uint32(value: &Json) -> u32 {
    u32::try_from(uint(value)).expect("fits u32")
}

fn opt_string(value: &Json) -> Option<String> {
    value.as_str().map(str::to_owned)
}

#[test]
fn preview() {
    for case in section("preview") {
        let max = usize::try_from(uint(&case["maxLength"])).expect("usize");
        let actual = journal_rules::extract_journal_preview(str_field(&case, "content"), max);
        assert_eq!(
            actual,
            str_field(&case, "expected"),
            "preview `{}`",
            case["name"]
        );
    }
}

#[test]
fn words() {
    for case in section("words") {
        let text = str_field(&case, "text");
        let characters = journal_rules::utf16_len(text);
        assert_eq!(
            journal_rules::count_words(text) as u64,
            uint(&case["words"]),
            "{case}"
        );
        assert_eq!(characters as u64, uint(&case["characters"]), "{case}");
        let level = journal_rules::calculate_activity_level(characters as u64);
        assert_eq!(u64::from(level), uint(&case["level"]), "{case}");
    }
}

#[test]
fn activity() {
    for case in section("activity") {
        let level = journal_rules::calculate_activity_level(uint(&case["characterCount"]));
        assert_eq!(u64::from(level), uint(&case["level"]), "{case}");
    }
}

#[test]
fn streak() {
    for case in section("streak") {
        let dates: Vec<&str> = case["dates"]
            .as_array()
            .expect("dates")
            .iter()
            .map(|date| date.as_str().expect("date"))
            .collect();
        let actual = journal_rules::compute_journal_streak(&dates, str_field(&case, "today"));
        let expected = &case["expected"];
        assert_eq!(
            (
                u64::from(actual.current_streak),
                u64::from(actual.longest_streak),
                actual.last_entry_date
            ),
            (
                uint(&expected["currentStreak"]),
                uint(&expected["longestStreak"]),
                opt_string(&expected["lastEntryDate"])
            ),
            "streak `{}`",
            case["name"]
        );
    }
}

#[test]
fn month_days() {
    for case in section("monthDays") {
        let year = case["year"].as_i64().expect("year");
        let actual =
            journal_rules::month_days(year, uint32(&case["month"]), str_field(&case, "today"));
        let actual: Vec<Json> = actual
            .into_iter()
            .map(
                |day| json!({"date": day.date, "isToday": day.is_today, "isFuture": day.is_future}),
            )
            .collect();
        assert_eq!(Json::Array(actual), case["expected"], "monthDays {case}");
    }
}

fn heatmap_day(value: &Json) -> JournalHeatmapDay {
    let day = JournalHeatmapDay {
        date: str_field(value, "date").to_owned(),
        character_count: uint(&value["characterCount"]),
        level: u8::try_from(uint(&value["level"])).expect("level"),
    };
    // The recorded level is `heatmapDay`'s output too.
    assert_eq!(
        journal_rules::heatmap_day(&day.date, day.character_count),
        day
    );
    day
}

#[test]
fn month_activity() {
    for case in section("monthActivity") {
        let heatmap: Vec<JournalHeatmapDay> = case["heatmap"]
            .as_array()
            .expect("heatmap")
            .iter()
            .map(heatmap_day)
            .collect();
        let year = case["year"].as_i64().expect("year");
        let actual: Vec<Json> = journal_rules::month_activity(year, &heatmap)
            .into_iter()
            .map(|month| {
                json!({
                    "month": month.month,
                    "entryCount": month.entry_count,
                    "totalChars": month.total_chars,
                    "activityDots": month.activity_dots,
                })
            })
            .collect();
        assert_eq!(
            Json::Array(actual),
            case["expected"],
            "monthActivity `{}`",
            case["name"]
        );
    }
}

#[test]
fn year_stats() {
    for case in section("yearStats") {
        let rows: Vec<JournalDayCounts> = case["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| JournalDayCounts {
                date: str_field(row, "date").to_owned(),
                word_count: row["wordCount"].as_u64(),
                character_count: row["characterCount"].as_u64(),
            })
            .collect();
        let actual: Vec<Json> = journal_rules::year_month_stats(&rows)
            .into_iter()
            .map(|month| {
                json!({
                    "month": month.month,
                    "entryCount": month.entry_count,
                    "totalWordCount": month.total_word_count,
                    "totalCharacterCount": month.total_character_count,
                    "averageLevel": month.average_level,
                })
            })
            .collect();
        let expected = case["expected"].as_array().expect("expected");
        assert_eq!(actual.len(), expected.len(), "yearStats `{}`", case["name"]);
        for (got, want) in actual.iter().zip(expected) {
            for field in [
                "month",
                "entryCount",
                "totalWordCount",
                "totalCharacterCount",
            ] {
                assert_eq!(uint(&got[field]), uint(&want[field]), "{field} in {case}");
            }
            assert_eq!(got["averageLevel"].as_f64(), want["averageLevel"].as_f64());
        }
        let counts: Vec<Option<u64>> = rows.iter().map(|row| row.character_count).collect();
        assert_eq!(
            Some(journal_rules::average_activity_level(&counts)),
            case["averageLevel"].as_f64(),
            "averageLevel `{}`",
            case["name"]
        );
    }
}

#[test]
fn weekday() {
    for case in section("weekday") {
        let actual = journal_rules::weekday_of(str_field(&case, "date")).map(u64::from);
        assert_eq!(actual, Some(uint(&case["weekday"])), "{case}");
    }
}

#[test]
fn ordered_weekdays() {
    for case in section("orderedWeekdays") {
        let actual = journal_rules::ordered_weekdays(uint32(&case["weekStartsOn"]));
        assert_eq!(json!(actual), case["expected"], "{case}");
    }
}

#[test]
fn template_resolution() {
    for case in section("templateResolution") {
        let settings = &case["settings"];
        let weekday_templates = settings.get("weekdayTemplates").map(|map| {
            map.as_object()
                .expect("weekdayTemplates")
                .iter()
                .map(|(key, id)| (key.clone(), opt_string(id)))
                .collect::<BTreeMap<_, _>>()
        });
        let settings = JournalTemplateSettings {
            default_template: opt_string(&settings["defaultTemplate"]),
            weekday_templates,
        };
        let actual =
            journal_rules::resolve_journal_template_id(&settings, str_field(&case, "date"));
        assert_eq!(
            actual,
            opt_string(&case["expected"]),
            "templateResolution `{}`",
            case["name"]
        );
    }
}

#[test]
fn template_apply() {
    for case in section("templateApply") {
        let formatted = &case["formatted"];
        let formatted = JournalTemplateFormatted {
            long_date: str_field(formatted, "longDate").to_owned(),
            time: str_field(formatted, "time").to_owned(),
            day_of_week: str_field(formatted, "dayOfWeek").to_owned(),
        };
        let template = &case["template"];
        let template = JournalTemplateSource {
            content: str_field(template, "content").to_owned(),
            tags: template["tags"]
                .as_array()
                .expect("tags")
                .iter()
                .map(|tag| tag.as_str().expect("tag").to_owned())
                .collect(),
            properties: template["properties"]
                .as_array()
                .expect("properties")
                .iter()
                .map(|property| JournalTemplateProperty {
                    name: str_field(property, "name").to_owned(),
                    value: property["value"].clone(),
                })
                .collect(),
        };
        let applied =
            journal_rules::apply_journal_template(&template, str_field(&case, "date"), &formatted);
        let properties: serde_json::Map<String, Json> = applied
            .properties
            .into_iter()
            .map(|property| (property.name, property.value))
            .collect();
        let actual = json!({
            "content": applied.content,
            "tags": applied.tags,
            "properties": properties,
        });
        assert_eq!(actual, case["expected"], "templateApply `{}`", case["name"]);
    }
}
