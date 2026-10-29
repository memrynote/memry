//! The definitions `properties.md` holds, read entry by entry as
//! `parsePropertyDefinitionEntries` (`packages/contracts/src/property-types.ts`) reads them,
//! and written back as `matter.stringify('', { properties })`.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use memry_core::markdown::frontmatter::{
    Eol, YamlMap, YamlValue, gray_matter_data, stringify_frontmatter_block,
};

/// The frontmatter key holding the definitions.
const PROPERTIES_KEY: &str = "properties";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectOption {
    pub value: String,
    pub color: String,
    pub default: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusCategory {
    pub label: String,
    pub options: Vec<SelectOption>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusCategories {
    pub todo: StatusCategory,
    pub in_progress: StatusCategory,
    pub done: StatusCategory,
}

/// A definition's type and what that type carries. `relation` is not one: its values type
/// themselves, and no build writes it to the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropertyKind {
    Text(Vec<SelectOption>),
    Number(Vec<SelectOption>),
    Checkbox(Vec<SelectOption>),
    Url(Vec<SelectOption>),
    Select(Vec<SelectOption>),
    Multiselect(Vec<SelectOption>),
    Status(StatusCategories),
    Date { show_on_calendar: bool },
    Project,
}

impl PropertyKind {
    /// The `type` the file spells.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Text(_) => "text",
            Self::Number(_) => "number",
            Self::Checkbox(_) => "checkbox",
            Self::Url(_) => "url",
            Self::Select(_) => "select",
            Self::Multiselect(_) => "multiselect",
            Self::Status(_) => "status",
            Self::Date { .. } => "date",
            Self::Project => "project",
        }
    }
}

/// One definition. An empty `default_value` or `color` is `None`: the file never holds one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyDefinition {
    pub kind: PropertyKind,
    pub default_value: Option<String>,
    pub color: Option<String>,
}

/// Definitions by name, in the order the file lists them; a new name goes last.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Definitions {
    entries: Vec<(String, PropertyDefinition)>,
    positions: HashMap<String, usize>,
}

impl Definitions {
    pub fn get(&self, name: &str) -> Option<&PropertyDefinition> {
        self.positions.get(name).map(|at| &self.entries[*at].1)
    }

    /// Replaces the definition of `name` where it stands, or adds it last.
    pub fn insert(&mut self, name: String, definition: PropertyDefinition) {
        match self.positions.get(&name) {
            Some(at) => self.entries[*at].1 = definition,
            None => {
                self.positions.insert(name.clone(), self.entries.len());
                self.entries.push((name, definition));
            }
        }
    }

    pub fn remove(&mut self, name: &str) -> Option<PropertyDefinition> {
        let at = self.positions.remove(name)?;
        let (_, removed) = self.entries.remove(at);
        for (position, (name, _)) in self.entries.iter().enumerate().skip(at) {
            self.positions.insert(name.clone(), position);
        }
        Some(removed)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &PropertyDefinition)> {
        self.entries.iter().map(|(name, def)| (name.as_str(), def))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// What `properties.md` holds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PropertiesFile {
    pub definitions: Definitions,
    /// Entries this build cannot read, as the file holds them. They are written back
    /// verbatim, unless a definition of the same name replaces one, so a rewrite never drops
    /// a definition an older or newer build wrote.
    unparsed: Vec<(String, YamlValue)>,
    /// A `relation` entry was dropped: older builds wrote synced relations here, and older
    /// builds refuse the whole file on one, so the next write leaves it out.
    healed: bool,
}

impl PropertiesFile {
    pub fn unparsed_names(&self) -> impl Iterator<Item = &str> {
        self.unparsed.iter().map(|(name, _)| name.as_str())
    }

    pub fn healed(&self) -> bool {
        self.healed
    }

    /// Nothing to write: no definition, no unparsed entry.
    pub fn is_empty(&self) -> bool {
        self.definitions.is_empty() && self.unparsed.is_empty()
    }

    /// The file's bytes: `matter.stringify('', { properties })`, the unparsed entries first,
    /// then the definitions.
    pub fn serialize(&self) -> Result<String, String> {
        let defined: HashSet<&str> = self.definitions.iter().map(|(name, _)| name).collect();
        let mut properties = YamlMap::new();
        for (name, entry) in &self.unparsed {
            if !defined.contains(name.as_str()) {
                properties.insert(name.clone(), entry.clone());
            }
        }
        for (name, definition) in self.definitions.iter() {
            properties.insert(name.to_owned(), definition_yaml(definition));
        }
        let mut data = YamlMap::new();
        data.insert(PROPERTIES_KEY.to_owned(), YamlValue::map(properties));
        let block = stringify_frontmatter_block(&data, Eol::Lf).map_err(|e| e.to_string())?;
        // gray-matter writes `newline('')` for the empty body.
        Ok(block + "\n")
    }
}

thread_local! {
    static STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Work the entry reader did on this thread: one step per entry, category and option and
/// one per byte of text it copies. For tests that bound it.
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(Cell::get)
}

/// The reader's work, capped at the length of the file. Without aliases every step stands
/// for bytes of its own in the file; with them, one list may be read once per reference, so
/// `options: *a` under a thousand names would copy `a` a thousand times.
struct Budget(usize);

#[derive(Debug)]
struct Exhausted;

impl Budget {
    fn spend(&mut self, steps: usize) -> Result<(), Exhausted> {
        STEPS.with(|count| count.set(count.get() + steps));
        self.0 = self.0.checked_sub(steps).ok_or(Exhausted)?;
        Ok(())
    }

    fn text(&mut self, text: &str) -> Result<String, Exhausted> {
        self.spend(text.len())?;
        Ok(text.to_owned())
    }
}

/// `raw` as `properties.md`, or why it cannot be read. Nothing in the file is ever dropped
/// because of another entry: an entry this build does not read is kept as it is.
pub fn parse(raw: &str) -> Result<PropertiesFile, String> {
    let data = gray_matter_data(raw).map_err(|e| format!("its frontmatter does not parse: {e}"))?;
    let properties = match &data {
        YamlValue::Map(top) => top.get(PROPERTIES_KEY),
        // gray-matter's data is then a list or a scalar, which has no `properties`.
        _ => None,
    };
    let entries = match properties {
        None | Some(YamlValue::Null) => return Ok(PropertiesFile::default()),
        Some(YamlValue::Map(entries)) => entries,
        // A list or a scalar is not the map the contracts parser reads, and a date or binary
        // here (an object to JavaScript, read as an empty or a numbered map) is refused too.
        Some(_) => return Err("its `properties` is not a map".to_owned()),
    };
    let mut budget = Budget(raw.len());
    let mut file = PropertiesFile::default();
    for (name, entry) in entries.iter() {
        let read = budget
            .spend(1)
            .and_then(|()| definition(entry, &mut budget))
            .map_err(|Exhausted| "its aliases expand past the file's own size".to_owned())?;
        match read {
            Read::Definition(definition) => file.definitions.insert(name.to_owned(), definition),
            Read::Relation => file.healed = true,
            Read::Unparsed => file.unparsed.push((name.to_owned(), entry.clone())),
        }
    }
    Ok(file)
}

enum Read {
    Definition(PropertyDefinition),
    Relation,
    Unparsed,
}

/// What zod's non-strict objects do: a key the schema does not name is ignored, a key it
/// names must have its type (`null` is no optional value), and a `min(1)` string is not
/// empty. An entry that fails the schema is [`Read::Unparsed`].
fn definition(entry: &YamlValue, budget: &mut Budget) -> Result<Read, Exhausted> {
    let YamlValue::Map(map) = entry else {
        return Ok(Read::Unparsed);
    };
    let type_name = match map.get("type") {
        Some(YamlValue::String(name)) => name.as_str(),
        _ => return Ok(Read::Unparsed),
    };
    if type_name == "relation" {
        return Ok(Read::Relation);
    }
    let (Some(default_value), Some(color)) = (
        optional_text(map, "defaultValue", budget)?,
        optional_text(map, "color", budget)?,
    ) else {
        return Ok(Read::Unparsed);
    };
    let options_of = |budget: &mut Budget, required: bool| match map.get("options") {
        None if !required => Ok(Some(Vec::new())),
        Some(value) => options(value, budget),
        None => Ok(None),
    };
    let kind = match type_name {
        "text" => options_of(budget, false)?.map(PropertyKind::Text),
        "number" => options_of(budget, false)?.map(PropertyKind::Number),
        "checkbox" => options_of(budget, false)?.map(PropertyKind::Checkbox),
        "url" => options_of(budget, false)?.map(PropertyKind::Url),
        "select" => options_of(budget, true)?.map(PropertyKind::Select),
        "multiselect" => options_of(budget, true)?.map(PropertyKind::Multiselect),
        "status" => categories(map.get("categories"), budget)?.map(PropertyKind::Status),
        "date" => match map.get("showOnCalendar") {
            None => Some(PropertyKind::Date {
                show_on_calendar: false,
            }),
            Some(YamlValue::Bool(show)) => Some(PropertyKind::Date {
                show_on_calendar: *show,
            }),
            Some(_) => None,
        },
        "project" => Some(PropertyKind::Project),
        _ => None,
    };
    Ok(match kind {
        Some(kind) => Read::Definition(PropertyDefinition {
            kind,
            default_value: default_value.filter(|text| !text.is_empty()),
            color: color.filter(|text| !text.is_empty()),
        }),
        None => Read::Unparsed,
    })
}

/// An optional string key: `Some(None)` when absent, `None` when present but not a string.
fn optional_text(
    map: &YamlMap,
    key: &str,
    budget: &mut Budget,
) -> Result<Option<Option<String>>, Exhausted> {
    Ok(match map.get(key) {
        None => Some(None),
        Some(YamlValue::String(text)) => Some(Some(budget.text(text)?)),
        Some(_) => None,
    })
}

fn options(value: &YamlValue, budget: &mut Budget) -> Result<Option<Vec<SelectOption>>, Exhausted> {
    let YamlValue::Seq(items) = value else {
        return Ok(None);
    };
    let mut options = Vec::with_capacity(items.len().min(1024));
    for item in items.iter() {
        budget.spend(1)?;
        let YamlValue::Map(option) = item else {
            return Ok(None);
        };
        let (Some(value), Some(color)) = (
            required_text(option, "value", budget)?,
            required_text(option, "color", budget)?,
        ) else {
            return Ok(None);
        };
        let default = match option.get("default") {
            None => None,
            Some(YamlValue::Bool(flag)) => Some(*flag),
            Some(_) => return Ok(None),
        };
        options.push(SelectOption {
            value,
            color,
            default,
        });
    }
    Ok(Some(options))
}

/// A `z.string().min(1)` key.
fn required_text(
    map: &YamlMap,
    key: &str,
    budget: &mut Budget,
) -> Result<Option<String>, Exhausted> {
    match map.get(key) {
        Some(YamlValue::String(text)) if !text.is_empty() => budget.text(text).map(Some),
        _ => Ok(None),
    }
}

fn categories(
    value: Option<&YamlValue>,
    budget: &mut Budget,
) -> Result<Option<StatusCategories>, Exhausted> {
    let Some(YamlValue::Map(map)) = value else {
        return Ok(None);
    };
    let mut category = |key: &str| -> Result<Option<StatusCategory>, Exhausted> {
        budget.spend(1)?;
        let Some(YamlValue::Map(category)) = map.get(key) else {
            return Ok(None);
        };
        let Some(label) = required_text(category, "label", budget)? else {
            return Ok(None);
        };
        let Some(options) = category
            .get("options")
            .map_or(Ok(None), |v| options(v, budget))?
        else {
            return Ok(None);
        };
        Ok(Some(StatusCategory { label, options }))
    };
    let (Some(todo), Some(in_progress), Some(done)) = (
        category("todo")?,
        category("in_progress")?,
        category("done")?,
    ) else {
        return Ok(None);
    };
    Ok(Some(StatusCategories {
        todo,
        in_progress,
        done,
    }))
}

fn text(value: &str) -> YamlValue {
    YamlValue::String(value.to_owned())
}

fn object(entries: Vec<(&str, YamlValue)>) -> YamlValue {
    let mut map = YamlMap::new();
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    YamlValue::Map(Arc::new(map))
}

fn options_yaml(options: &[SelectOption]) -> YamlValue {
    YamlValue::seq(
        options
            .iter()
            .map(|option| {
                let mut entries = vec![
                    ("value", text(&option.value)),
                    ("color", text(&option.color)),
                ];
                if let Some(flag) = option.default {
                    entries.push(("default", YamlValue::Bool(flag)));
                }
                object(entries)
            })
            .collect(),
    )
}

fn category_yaml(category: &StatusCategory) -> YamlValue {
    object(vec![
        ("label", text(&category.label)),
        ("options", options_yaml(&category.options)),
    ])
}

/// `serializeFile`'s shape for one definition: `type`, what the type carries, then the
/// shared fields.
fn definition_yaml(definition: &PropertyDefinition) -> YamlValue {
    let mut entries = vec![("type", text(definition.kind.type_name()))];
    match &definition.kind {
        PropertyKind::Text(options)
        | PropertyKind::Number(options)
        | PropertyKind::Checkbox(options)
        | PropertyKind::Url(options)
        | PropertyKind::Select(options)
        | PropertyKind::Multiselect(options) => entries.push(("options", options_yaml(options))),
        PropertyKind::Status(categories) => entries.push((
            "categories",
            object(vec![
                ("todo", category_yaml(&categories.todo)),
                ("in_progress", category_yaml(&categories.in_progress)),
                ("done", category_yaml(&categories.done)),
            ]),
        )),
        PropertyKind::Date { show_on_calendar } => {
            entries.push(("showOnCalendar", YamlValue::Bool(*show_on_calendar)));
        }
        PropertyKind::Project => {}
    }
    if let Some(value) = &definition.default_value {
        entries.push(("defaultValue", text(value)));
    }
    if let Some(color) = &definition.color {
        entries.push(("color", text(color)));
    }
    object(entries)
}
