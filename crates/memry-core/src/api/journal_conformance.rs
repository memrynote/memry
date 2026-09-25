//! The conformance seam for the `journal` vector class (spec 005-journal
//! JP080).
//!
//! `journal.json` pins pure rules the shell otherwise reaches through an
//! opened vault (`Journal.month`, `year`, `streak`, template seeding). Its
//! cases carry inputs no FFI write can mint (fixed character counts, a
//! `today` in any year), so, as [`crate::api::task_conformance`] does, this
//! takes the file's own JSON, runs every section through the **same**
//! `domain::journal_rules` functions the vault path calls, and answers JSON in
//! the file's shape for the Swift harness to compare.
//!
//! **Reads only.** No database, no vault, no clock.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::domain::journal_rules::{
    self, JournalDayCounts, JournalHeatmapDay, JournalTemplateFormatted, JournalTemplateProperty,
    JournalTemplateSettings, JournalTemplateSource,
};

fn cases<'a>(file: &'a Value, name: &str) -> &'a [Value] {
    file[name].as_array().map(Vec::as_slice).unwrap_or_default()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn uint(value: &Value) -> u64 {
    value.as_u64().unwrap_or_default()
}

fn heatmap_day(value: &Value) -> JournalHeatmapDay {
    JournalHeatmapDay {
        date: text(value, "date").to_owned(),
        character_count: uint(&value["characterCount"]),
        level: u8::try_from(uint(&value["level"])).unwrap_or_default(),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Every section of `journal.json`, computed: `{ section: [expected, ...] }`
/// in case order, each `expected` in the file's own shape.
#[uniffi::export]
pub fn journal_conformance(file_json: String) -> String {
    let file: Value = serde_json::from_str(&file_json).unwrap_or(Value::Null);
    let mut out = Map::new();

    out.insert(
        "preview".into(),
        cases(&file, "preview")
            .iter()
            .map(|case| {
                let max = usize::try_from(uint(&case["maxLength"])).unwrap_or(100);
                json!(journal_rules::extract_journal_preview(
                    text(case, "content"),
                    max
                ))
            })
            .collect(),
    );
    out.insert(
        "words".into(),
        cases(&file, "words")
            .iter()
            .map(|case| {
                let body = text(case, "text");
                let characters = journal_rules::utf16_len(body) as u64;
                json!({
                    "words": journal_rules::count_words(body),
                    "characters": characters,
                    "level": journal_rules::calculate_activity_level(characters),
                })
            })
            .collect(),
    );
    out.insert(
        "activity".into(),
        cases(&file, "activity")
            .iter()
            .map(|case| {
                json!(journal_rules::calculate_activity_level(uint(
                    &case["characterCount"]
                )))
            })
            .collect(),
    );
    out.insert(
        "streak".into(),
        cases(&file, "streak")
            .iter()
            .map(|case| {
                let dates = strings(&case["dates"]);
                let streak = journal_rules::compute_journal_streak(&dates, text(case, "today"));
                json!({
                    "currentStreak": streak.current_streak,
                    "longestStreak": streak.longest_streak,
                    "lastEntryDate": streak.last_entry_date,
                })
            })
            .collect(),
    );
    out.insert(
        "monthDays".into(),
        cases(&file, "monthDays")
            .iter()
            .map(|case| {
                let days = journal_rules::month_days(
                    case["year"].as_i64().unwrap_or_default(),
                    u32::try_from(uint(&case["month"])).unwrap_or_default(),
                    text(case, "today"),
                );
                days.into_iter()
                    .map(|day| {
                        json!({"date": day.date, "isToday": day.is_today, "isFuture": day.is_future})
                    })
                    .collect::<Value>()
            })
            .collect(),
    );
    out.insert(
        "monthActivity".into(),
        cases(&file, "monthActivity")
            .iter()
            .map(|case| {
                let heatmap: Vec<JournalHeatmapDay> = case["heatmap"]
                    .as_array()
                    .map(|days| days.iter().map(heatmap_day).collect())
                    .unwrap_or_default();
                journal_rules::month_activity(case["year"].as_i64().unwrap_or_default(), &heatmap)
                    .into_iter()
                    .map(|month| {
                        json!({
                            "month": month.month,
                            "entryCount": month.entry_count,
                            "totalChars": month.total_chars,
                            "activityDots": month.activity_dots,
                        })
                    })
                    .collect::<Value>()
            })
            .collect(),
    );
    out.insert(
        "yearStats".into(),
        cases(&file, "yearStats")
            .iter()
            .map(|case| {
                let rows: Vec<JournalDayCounts> = case["rows"]
                    .as_array()
                    .map(|rows| {
                        rows.iter()
                            .map(|row| JournalDayCounts {
                                date: text(row, "date").to_owned(),
                                word_count: row["wordCount"].as_u64(),
                                character_count: row["characterCount"].as_u64(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                journal_rules::year_month_stats(&rows)
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
                    .collect::<Value>()
            })
            .collect(),
    );
    out.insert(
        "weekday".into(),
        cases(&file, "weekday")
            .iter()
            .map(|case| json!(journal_rules::weekday_of(text(case, "date"))))
            .collect(),
    );
    out.insert(
        "orderedWeekdays".into(),
        cases(&file, "orderedWeekdays")
            .iter()
            .map(|case| {
                json!(journal_rules::ordered_weekdays(
                    u32::try_from(uint(&case["weekStartsOn"])).unwrap_or_default()
                ))
            })
            .collect(),
    );
    out.insert(
        "templateResolution".into(),
        cases(&file, "templateResolution")
            .iter()
            .map(|case| {
                let settings = &case["settings"];
                let weekday_templates = settings["weekdayTemplates"].as_object().map(|map| {
                    map.iter()
                        .map(|(key, id)| (key.clone(), id.as_str().map(str::to_owned)))
                        .collect::<BTreeMap<_, _>>()
                });
                let settings = JournalTemplateSettings {
                    default_template: settings["defaultTemplate"].as_str().map(str::to_owned),
                    weekday_templates,
                };
                json!(journal_rules::resolve_journal_template_id(
                    &settings,
                    text(case, "date")
                ))
            })
            .collect(),
    );
    out.insert(
        "templateApply".into(),
        cases(&file, "templateApply")
            .iter()
            .map(|case| {
                let formatted = &case["formatted"];
                let formatted = JournalTemplateFormatted {
                    long_date: text(formatted, "longDate").to_owned(),
                    time: text(formatted, "time").to_owned(),
                    day_of_week: text(formatted, "dayOfWeek").to_owned(),
                };
                let template = &case["template"];
                let source = JournalTemplateSource {
                    content: text(template, "content").to_owned(),
                    tags: strings(&template["tags"]),
                    properties: template["properties"]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .map(|property| JournalTemplateProperty {
                                    name: text(property, "name").to_owned(),
                                    value: property["value"].clone(),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                };
                let applied =
                    journal_rules::apply_journal_template(&source, text(case, "date"), &formatted);
                let properties: Map<String, Value> = applied
                    .properties
                    .into_iter()
                    .map(|property| (property.name, property.value))
                    .collect();
                json!({
                    "content": applied.content,
                    "tags": applied.tags,
                    "properties": properties,
                })
            })
            .collect(),
    );
    Value::Object(out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `2.0` and `2` are the same JSON number to every reader of the file.
    fn normalised(value: &Value) -> Value {
        match value {
            Value::Number(number) => number
                .as_f64()
                .filter(|float| float.fract() == 0.0 && float.abs() < 9.0e15)
                .map(|float| json!(float as i64))
                .unwrap_or_else(|| value.clone()),
            Value::Array(items) => Value::Array(items.iter().map(normalised).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), normalised(item)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    #[test]
    fn every_section_matches_the_committed_vectors() {
        let raw = include_str!("../../../../packages/contracts/test-vectors/journal.json");
        let file: Value = serde_json::from_str(raw).expect("vectors");
        let computed: Value =
            serde_json::from_str(&journal_conformance(raw.to_owned())).expect("json");
        for (section, value) in computed.as_object().expect("object") {
            let got = value.as_array().expect("array");
            let want = cases(&file, section);
            assert_eq!(got.len(), want.len(), "{section}");
            for (index, case) in want.iter().enumerate() {
                let expected = match section.as_str() {
                    "words" => json!({
                        "words": case["words"], "characters": case["characters"], "level": case["level"]
                    }),
                    "activity" => case["level"].clone(),
                    "weekday" => case["weekday"].clone(),
                    _ => case["expected"].clone(),
                };
                assert_eq!(
                    normalised(&got[index]),
                    normalised(&expected),
                    "{section}[{index}]"
                );
            }
        }
    }
}
