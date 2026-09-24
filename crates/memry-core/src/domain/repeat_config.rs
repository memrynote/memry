//! A task's `repeatConfig`, read from and written to desktop's wire shape
//! (spec 004 D3, D7; §5 of the plan).
//!
//! On the wire the field is opaque JSON (`z.unknown()`, chapter 13 §13.7.3).
//! Desktop writes `{frequency, interval, daysOfWeek?, monthlyType?, dayOfMonth?,
//! weekOfMonth?, dayOfWeekForMonth?, endType, endDate: 'YYYY-MM-DD' | null,
//! endCount?, completedCount, createdAt: ISO}` and reads it back only when
//! `frequency` and `endType` are both present (`use-task-queries.ts`
//! `dbRepeatConfigToUiRepeatConfig`). [`RepeatConfig::from_wire`] is that read;
//! [`RepeatConfig::to_wire`] is that write. A payload in any other shape (the
//! staging vault holds `{"freq":"daily","until":…}` rows) reads as `None` and
//! is preserved untouched by the caller, never rewritten.

use serde_json::{Map, Value, json};

use super::calendar::{CivilDate, LocalDateTime};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
    /// A value this build does not know. Desktop keeps it and computes no next
    /// occurrence for it; so does the core.
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonthlyType {
    DayOfMonth,
    WeekPattern,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndType {
    Never,
    Date,
    Count,
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepeatConfig {
    pub frequency: Frequency,
    pub interval: i64,
    /// 0 = Sunday .. 6 = Saturday, in the order written.
    pub days_of_week: Option<Vec<i64>>,
    pub monthly_type: Option<MonthlyType>,
    pub day_of_month: Option<i64>,
    /// 1..=4, or 5 for "last".
    pub week_of_month: Option<i64>,
    pub day_of_week_for_month: Option<i64>,
    pub end_type: EndType,
    /// The instant the series ends at (desktop parses the key with `new Date`).
    pub end_date: Option<LocalDateTime>,
    pub end_count: Option<i64>,
    pub completed_count: i64,
    /// Verbatim ISO string, or `None` when the payload carried none.
    pub created_at: Option<String>,
}

impl RepeatConfig {
    /// A fresh config as desktop's pickers build one: never ends, zero done.
    pub fn new(frequency: Frequency, interval: i64, created_at: String) -> Self {
        Self {
            frequency,
            interval,
            days_of_week: None,
            monthly_type: None,
            day_of_month: None,
            week_of_month: None,
            day_of_week_for_month: None,
            end_type: EndType::Never,
            end_date: None,
            end_count: None,
            completed_count: 0,
            created_at: Some(created_at),
        }
    }

    /// Desktop's read: `None` unless `frequency` and `endType` are present.
    pub fn from_wire(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let frequency = match non_empty_str(object, "frequency")? {
            "daily" => Frequency::Daily,
            "weekly" => Frequency::Weekly,
            "monthly" => Frequency::Monthly,
            "yearly" => Frequency::Yearly,
            other => Frequency::Other(other.to_owned()),
        };
        let end_type = match non_empty_str(object, "endType")? {
            "never" => EndType::Never,
            "date" => EndType::Date,
            "count" => EndType::Count,
            other => EndType::Other(other.to_owned()),
        };
        let monthly_type = match object.get("monthlyType").and_then(Value::as_str) {
            Some("dayOfMonth") => Some(MonthlyType::DayOfMonth),
            Some("weekPattern") => Some(MonthlyType::WeekPattern),
            _ => None,
        };
        let days_of_week = object
            .get("daysOfWeek")
            .and_then(Value::as_array)
            .map(|days| days.iter().filter_map(integer).collect());
        let end_date = object
            .get("endDate")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .and_then(LocalDateTime::parse);
        Some(Self {
            frequency,
            interval: object.get("interval").and_then(integer).unwrap_or(1),
            days_of_week,
            monthly_type,
            day_of_month: object.get("dayOfMonth").and_then(integer),
            week_of_month: object.get("weekOfMonth").and_then(integer),
            day_of_week_for_month: object.get("dayOfWeekForMonth").and_then(integer),
            end_type,
            end_date,
            end_count: object.get("endCount").and_then(integer),
            completed_count: object.get("completedCount").and_then(integer).unwrap_or(0),
            created_at: object
                .get("createdAt")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    /// Desktop's write (`toServiceRepeatConfig`): absent optionals are omitted,
    /// `endDate` is a `YYYY-MM-DD` key or `null`.
    pub fn to_wire(&self) -> Value {
        let mut object = Map::new();
        object.insert("frequency".into(), json!(self.frequency.as_str()));
        object.insert("interval".into(), json!(self.interval));
        if let Some(days) = &self.days_of_week {
            object.insert("daysOfWeek".into(), json!(days));
        }
        if let Some(monthly) = self.monthly_type {
            object.insert("monthlyType".into(), json!(monthly.as_str()));
        }
        insert_some(&mut object, "dayOfMonth", self.day_of_month);
        insert_some(&mut object, "weekOfMonth", self.week_of_month);
        insert_some(&mut object, "dayOfWeekForMonth", self.day_of_week_for_month);
        object.insert("endType".into(), json!(self.end_type.as_str()));
        object.insert(
            "endDate".into(),
            self.end_date
                .map_or(Value::Null, |end| json!(end.date().key())),
        );
        insert_some(&mut object, "endCount", self.end_count);
        object.insert("completedCount".into(), json!(self.completed_count));
        if let Some(created) = &self.created_at {
            object.insert("createdAt".into(), json!(created));
        }
        Value::Object(object)
    }

    /// The end date as a calendar date, when the series ends on one.
    pub fn end_day(&self) -> Option<CivilDate> {
        self.end_date.map(LocalDateTime::date)
    }
}

impl Frequency {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Yearly => "yearly",
            Self::Other(other) => other,
        }
    }
}

impl MonthlyType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DayOfMonth => "dayOfMonth",
            Self::WeekPattern => "weekPattern",
        }
    }
}

impl EndType {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Never => "never",
            Self::Date => "date",
            Self::Count => "count",
            Self::Other(other) => other,
        }
    }
}

/// Returns a copy of `wire` with `completedCount` set, every other key —
/// known or not — kept verbatim (D7: unknown payload fields are preserved).
pub fn with_completed_count(wire: &Value, completed_count: i64) -> Value {
    let mut copy = wire.clone();
    if let Some(object) = copy.as_object_mut() {
        object.insert("completedCount".into(), json!(completed_count));
    }
    copy
}

/// JS truthiness for a string field: missing, empty or non-string is absent.
fn non_empty_str<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// A JSON number that is a whole number (`3` or `3.0`).
fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.fract() == 0.0 && number.is_finite())
            .map(|number| number as i64)
    })
}

fn insert_some(object: &mut Map<String, Value>, key: &str, value: Option<i64>) {
    if let Some(value) = value {
        object.insert(key.into(), json!(value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_shape_round_trips() {
        let wire = json!({
            "frequency": "monthly", "interval": 1, "monthlyType": "weekPattern",
            "weekOfMonth": 5, "dayOfWeekForMonth": 0, "endType": "date",
            "endDate": "2026-06-30", "completedCount": 2,
            "createdAt": "2026-01-01T00:00:00.000Z"
        });
        let config = RepeatConfig::from_wire(&wire).expect("reads");
        assert_eq!(config.to_wire(), wire);
    }

    #[test]
    fn a_foreign_shape_is_not_a_config() {
        assert!(
            RepeatConfig::from_wire(&json!({"freq": "daily", "until": "2026-09-25"})).is_none()
        );
        assert!(RepeatConfig::from_wire(&json!({"frequency": "daily"})).is_none());
        assert!(RepeatConfig::from_wire(&json!(null)).is_none());
    }

    #[test]
    fn bumping_the_count_keeps_unknown_keys() {
        let wire = json!({"frequency": "daily", "endType": "never", "completedCount": 1, "x": 9});
        let next = with_completed_count(&wire, 2);
        assert_eq!(next["completedCount"], json!(2));
        assert_eq!(next["x"], json!(9));
    }
}
