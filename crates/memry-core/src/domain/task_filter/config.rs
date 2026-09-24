//! [`TaskFilters`] and [`TaskSort`]: desktop's saved-filter `config` shape
//! (`packages/contracts/src/saved-filters-api.ts`), read and written as JSON.
//!
//! Reading fills a missing field with the zod default (`search: ''`, arrays
//! `[]`, `dueDate: {type: 'any'}`, `completion: 'active'`, `repeatType` and
//! `hasTime: 'all'`). A saved filter syncs between builds, so an enum value this
//! build does not know is kept in an `Other` variant and written back verbatim;
//! the filters treat it as the TypeScript `switch` default does.
//!
//! `customStart`/`customEnd` stay the text the row carried: desktop writes a
//! `toISOString()` instant, the vectors a `YYYY-MM-DD` key. Both read through
//! [`crate::domain::calendar::LocalDateTime::parse`] when the filter runs, and
//! the text round-trips untouched.

use serde_json::{Value, json};

/// A wire enum: known names map to variants, anything else is kept as `Other`.
macro_rules! wire_enum {
    ($(#[$doc:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant,)+
            /// A value from a newer build, preserved verbatim.
            Other(String),
        }

        impl $name {
            /// Reads a wire name; an unknown one is kept as `Other`.
            pub fn from_name(name: &str) -> Self {
                match name {
                    $($text => Self::$variant,)+
                    other => Self::Other(other.to_owned()),
                }
            }

            /// The wire name.
            pub fn name(&self) -> &str {
                match self {
                    $(Self::$variant => $text,)+
                    Self::Other(other) => other,
                }
            }
        }
    };
}

wire_enum!(
    /// `dueDate.type`.
    DueDateKind {
        Any => "any",
        None => "none",
        Overdue => "overdue",
        Today => "today",
        Tomorrow => "tomorrow",
        ThisWeek => "this-week",
        NextWeek => "next-week",
        ThisMonth => "this-month",
        Custom => "custom",
    }
);

wire_enum!(
    /// `completion`: `archived` is the archived-only scope.
    CompletionFilter {
        Active => "active",
        Completed => "completed",
        All => "all",
        Archived => "archived",
    }
);

wire_enum!(
    /// `repeatType`.
    RepeatFilter {
        All => "all",
        Repeating => "repeating",
        OneTime => "one-time",
    }
);

wire_enum!(
    /// `hasTime`.
    HasTimeFilter {
        All => "all",
        WithTime => "with-time",
        WithoutTime => "without-time",
    }
);

wire_enum!(
    /// `sort.field`. An unknown field leaves the order untouched and yields no
    /// groups.
    SortField {
        DueDate => "dueDate",
        Priority => "priority",
        Status => "status",
        CreatedAt => "createdAt",
        Title => "title",
        Project => "project",
        CompletedAt => "completedAt",
        Folder => "folder",
        Note => "note",
    }
);

wire_enum!(
    /// `sort.direction`. Anything but `desc` sorts ascending, as in desktop.
    SortDirection {
        Asc => "asc",
        Desc => "desc",
    }
);

/// The due-date dimension of a filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueDateFilter {
    pub kind: DueDateKind,
    /// The range start as the row carried it (ISO instant or `YYYY-MM-DD`).
    pub custom_start: Option<String>,
    /// The range end as the row carried it (ISO instant or `YYYY-MM-DD`).
    pub custom_end: Option<String>,
}

impl Default for DueDateFilter {
    fn default() -> Self {
        Self {
            kind: DueDateKind::Any,
            custom_start: None,
            custom_end: None,
        }
    }
}

impl DueDateFilter {
    /// Reads `{type, customStart?, customEnd?}`; a missing `type` is `any`.
    pub fn from_json(value: &Value) -> Self {
        Self {
            kind: value
                .get("type")
                .and_then(Value::as_str)
                .map_or(DueDateKind::Any, DueDateKind::from_name),
            custom_start: string_field(value, "customStart"),
            custom_end: string_field(value, "customEnd"),
        }
    }

    /// Desktop's write: both range ends always present, `null` when unset.
    pub fn to_json(&self) -> Value {
        json!({
            "type": self.kind.name(),
            "customStart": self.custom_start,
            "customEnd": self.custom_end,
        })
    }
}

/// A saved filter's `filters` object. `Default` is desktop's default filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskFilters {
    pub search: String,
    pub project_ids: Vec<String>,
    /// Priority names as the wire carries them ([`super::Priority::name`]).
    /// Text rather than [`super::Priority`] so a name from a newer build
    /// round-trips; like in desktop, it matches no task.
    pub priorities: Vec<String>,
    pub tags: Vec<String>,
    pub due_date: DueDateFilter,
    pub status_ids: Vec<String>,
    pub completion: CompletionFilter,
    pub repeat_type: RepeatFilter,
    pub has_time: HasTimeFilter,
}

impl Default for TaskFilters {
    fn default() -> Self {
        Self {
            search: String::new(),
            project_ids: Vec::new(),
            priorities: Vec::new(),
            tags: Vec::new(),
            due_date: DueDateFilter::default(),
            status_ids: Vec::new(),
            completion: CompletionFilter::Active,
            repeat_type: RepeatFilter::All,
            has_time: HasTimeFilter::All,
        }
    }
}

impl TaskFilters {
    /// Reads a saved filter's `filters` object; missing or mistyped fields take
    /// the zod default.
    pub fn from_json(value: &Value) -> Self {
        let name = |key: &str| value.get(key).and_then(Value::as_str);
        Self {
            search: name("search").unwrap_or_default().to_owned(),
            project_ids: string_array(value, "projectIds"),
            priorities: string_array(value, "priorities"),
            tags: string_array(value, "tags"),
            due_date: value
                .get("dueDate")
                .filter(|due| due.is_object())
                .map_or_else(DueDateFilter::default, DueDateFilter::from_json),
            status_ids: string_array(value, "statusIds"),
            completion: name("completion")
                .map_or(CompletionFilter::Active, CompletionFilter::from_name),
            repeat_type: name("repeatType").map_or(RepeatFilter::All, RepeatFilter::from_name),
            has_time: name("hasTime").map_or(HasTimeFilter::All, HasTimeFilter::from_name),
        }
    }

    /// Desktop's write (`frontendToDbConfig`): every field present.
    pub fn to_json(&self) -> Value {
        json!({
            "search": self.search,
            "projectIds": self.project_ids,
            "priorities": self.priorities,
            "tags": self.tags,
            "dueDate": self.due_date.to_json(),
            "statusIds": self.status_ids,
            "completion": self.completion.name(),
            "repeatType": self.repeat_type.name(),
            "hasTime": self.has_time.name(),
        })
    }
}

/// A saved filter's `sort` object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSort {
    pub field: SortField,
    pub direction: SortDirection,
}

impl TaskSort {
    /// Reads `{field, direction}`. `None` unless both are strings: `sort` is
    /// optional in a saved filter, and zod requires both when it is there.
    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            field: SortField::from_name(value.get("field")?.as_str()?),
            direction: SortDirection::from_name(value.get("direction")?.as_str()?),
        })
    }

    pub fn to_json(&self) -> Value {
        json!({ "field": self.field.name(), "direction": self.direction.name() })
    }
}

/// The strings of an array field; a missing or non-array field is empty and a
/// non-string element is skipped (zod would reject the row).
fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
