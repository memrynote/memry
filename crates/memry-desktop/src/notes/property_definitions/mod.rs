//! Property definitions (#3530 Step 13k): the definition and option commands of
//! `ipc/notes-handlers.ts` over `PropertyDefinitionsService` (`vault/property-definitions.ts`).
//!
//! Two stores hold the definitions. `.memry/properties.md` ([`properties_file`]) is the one
//! people edit and older builds share; the synced `property_definition` records are the ones
//! other devices see. The app shows their union, the file winning for every name it lists, as
//! Electron's reload folds the synced rows into what the file holds.
//!
//! Every edit runs in one turn: it reads the union's definition of the name, writes the file
//! through [`properties_file::update`], then makes the record equal to what the file now
//! holds, as Electron's rebuild of its rows and `enqueuePropertyDefinitionUpsert` do. A file
//! that cannot be read refuses the edit, and neither store changes. When the record write
//! fails after the file was written, the error reaches the caller and the next edit of the
//! name writes the record again. A date's calendar flag lives only in this device's file.
//!
//! Not yet ported: writing a pulled definition into the file (`applyRemoteUpsert`, #2896), so
//! until then the file shadows a newer record of a name it lists; and re-typing the indexed
//! note values when a definition changes type (`retypeIndexedProperties`), which waits for the
//! note property index.

mod record;
mod view;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::AuthError;
use memry_core::domain::property_admin::records::{DefinitionRecords, StoredDefinition};
use memry_core::seams::secure_store::SecureStore;

use crate::session::OpenVault;
use crate::vault::consumer::rows::now_ms;
use crate::vault::properties_file::{
    self, PropertyDefinition, PropertyKind, SelectOption, StatusCategories,
};
use record::{default_categories, definition_of, options_text, record_of};
pub use view::{
    DefinitionInput, DefinitionType, DefinitionsError, EnsuredType, OptionInput,
    PropertyDefinitionView, StatusCategoryKey,
};

/// What an edit does to the name's definition.
enum Next {
    Keep,
    Put(PropertyDefinition),
    Remove,
}

/// Serializes every edit of every vault's definitions in this process, so the file and the
/// record of a name are written in the same order: without it, a second edit could write the
/// file and its record between this edit's file write and record write, and this edit's older
/// definition would land in the record last. Taken before the file's own lock and never inside
/// a database call.
static TURN: Mutex<()> = Mutex::new(());

fn named(name: &str) -> Result<&str, DefinitionsError> {
    if name.is_empty() {
        return Err(DefinitionsError::Invalid("a property needs a name"));
    }
    Ok(name)
}

fn option(input: OptionInput) -> SelectOption {
    SelectOption {
        value: input.value,
        color: input.color,
        default: input.default,
    }
}

/// An option of `add_option`, `add_status_option`: `PropertyOptionInputSchema`, which keeps
/// only the value and the color.
fn new_option(input: OptionInput) -> Result<SelectOption, DefinitionsError> {
    if input.value.is_empty() || input.color.is_empty() {
        return Err(DefinitionsError::Invalid(
            "an option needs a value and a color",
        ));
    }
    Ok(SelectOption {
        default: None,
        ..option(input)
    })
}

fn option_list(kind: &mut PropertyKind) -> Option<&mut Vec<SelectOption>> {
    match kind {
        PropertyKind::Text(options)
        | PropertyKind::Number(options)
        | PropertyKind::Checkbox(options)
        | PropertyKind::Url(options)
        | PropertyKind::Select(options)
        | PropertyKind::Multiselect(options) => Some(options),
        PropertyKind::Status(_) | PropertyKind::Date { .. } | PropertyKind::Project => None,
    }
}

/// The option list of a type that has one.
fn options_of(kind: Option<&PropertyKind>) -> Vec<SelectOption> {
    kind.and_then(|kind| option_list(&mut kind.clone()).map(std::mem::take))
        .unwrap_or_default()
}

/// Every option list of the definition: the type's own, or each status category's.
fn each_list(kind: &mut PropertyKind, mut change: impl FnMut(&mut Vec<SelectOption>)) {
    if let PropertyKind::Status(categories) = kind {
        for category in [
            &mut categories.todo,
            &mut categories.in_progress,
            &mut categories.done,
        ] {
            change(&mut category.options);
        }
    } else if let Some(options) = option_list(kind) {
        change(options);
    }
}

/// The kind of type `wanted`, keeping what `prior` (the definition it replaces) carries that
/// the type has too; `options` replaces an option list. `normalizeDefinition` of Electron.
fn kind_of(
    wanted: DefinitionType,
    options: Option<Vec<OptionInput>>,
    prior: Option<&PropertyKind>,
) -> PropertyKind {
    let list = || {
        options.map_or_else(
            || options_of(prior),
            |options| options.into_iter().map(option).collect(),
        )
    };
    match wanted {
        DefinitionType::Text => PropertyKind::Text(list()),
        DefinitionType::Number => PropertyKind::Number(list()),
        DefinitionType::Checkbox => PropertyKind::Checkbox(list()),
        DefinitionType::Url => PropertyKind::Url(list()),
        DefinitionType::Select => PropertyKind::Select(list()),
        DefinitionType::Multiselect => PropertyKind::Multiselect(list()),
        DefinitionType::Status => match prior {
            Some(PropertyKind::Status(categories)) => PropertyKind::Status(categories.clone()),
            _ => PropertyKind::Status(default_categories()),
        },
        DefinitionType::Project => PropertyKind::Project,
        DefinitionType::Date => PropertyKind::Date {
            show_on_calendar: matches!(
                prior,
                Some(PropertyKind::Date {
                    show_on_calendar: true
                })
            ),
        },
    }
}

fn type_of(kind: &PropertyKind) -> DefinitionType {
    match kind {
        PropertyKind::Text(_) => DefinitionType::Text,
        PropertyKind::Number(_) => DefinitionType::Number,
        PropertyKind::Checkbox(_) => DefinitionType::Checkbox,
        PropertyKind::Url(_) => DefinitionType::Url,
        PropertyKind::Select(_) => DefinitionType::Select,
        PropertyKind::Multiselect(_) => DefinitionType::Multiselect,
        PropertyKind::Status(_) => DefinitionType::Status,
        PropertyKind::Date { .. } => DefinitionType::Date,
        PropertyKind::Project => DefinitionType::Project,
    }
}

/// The type a create or an update names: any but `project`.
fn editable(wanted: Option<DefinitionType>) -> Result<Option<DefinitionType>, DefinitionsError> {
    match wanted {
        Some(DefinitionType::Project) => Err(DefinitionsError::Invalid(
            "the project property is managed by the app",
        )),
        wanted => Ok(wanted),
    }
}

fn filled(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty())
}

fn view_of(
    name: &str,
    definition: &PropertyDefinition,
    created_at: String,
) -> PropertyDefinitionView {
    PropertyDefinitionView {
        name: name.to_owned(),
        type_name: type_of(&definition.kind),
        options: options_text(&definition.kind),
        default_value: definition.default_value.clone(),
        color: definition.color.clone(),
        created_at,
    }
}

/// The definitions of one open vault.
pub struct PropertyDefinitions {
    vault: PathBuf,
    records: DefinitionRecords,
}

impl PropertyDefinitions {
    pub fn new(vault: PathBuf, records: DefinitionRecords) -> Self {
        Self { vault, records }
    }

    /// The definitions of `open`, whose records are written under the device identity in
    /// `store` (minted on the first synced write of a profile; sign-in reuses it).
    pub fn open(open: &OpenVault, store: Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        ensure_device_identity(store.clone())?;
        Ok(Self::new(
            open.path.clone(),
            open.vault.property_definition_records(store)?,
        ))
    }

    /// What the file holds, or nothing with a warning when it cannot be read: the records
    /// still show, and an edit says why it is refused.
    fn file(&self) -> Option<properties_file::PropertiesFile> {
        match properties_file::read(&self.vault) {
            Ok(file) => Some(file),
            Err(error) => {
                tracing::warn!(
                    scope = "PropertyDefinitions",
                    "showing the synced definitions only: {error}"
                );
                None
            }
        }
    }

    /// Every definition, by name (`notes:get-property-definitions`).
    pub fn list(&self) -> Result<Vec<PropertyDefinitionView>, DefinitionsError> {
        let records = self.records.list()?;
        let mut views: Vec<PropertyDefinitionView> = Vec::new();
        let file = self.file();
        let created = |name: &str| {
            records
                .iter()
                .find(|stored| stored.record.name == name)
                .and_then(|stored| stored.created_at.clone())
                .unwrap_or_default()
        };
        if let Some(file) = &file {
            for (name, definition) in file.definitions.iter() {
                views.push(view_of(name, definition, created(name)));
            }
        }
        let in_file = |name: &str| {
            file.as_ref()
                .is_some_and(|file| file.definitions.get(name).is_some())
        };
        for stored in records
            .iter()
            .filter(|stored| !in_file(&stored.record.name))
        {
            if let Some(definition) = definition_of(&stored.record) {
                let created_at = stored.created_at.clone().unwrap_or_default();
                views.push(view_of(&stored.record.name, &definition, created_at));
            }
        }
        views.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(views)
    }

    /// The date properties shown on the calendar, in the file's order.
    pub fn calendar_names(&self) -> Vec<String> {
        let Some(file) = self.file() else {
            return Vec::new();
        };
        file.definitions
            .iter()
            .filter(|(_, definition)| {
                matches!(
                    definition.kind,
                    PropertyKind::Date {
                        show_on_calendar: true
                    }
                )
            })
            .map(|(name, _)| name.to_owned())
            .collect()
    }

    /// One edit of `name`'s definition: `decide` gets the union's definition and says what
    /// becomes of it.
    fn change<T>(
        &self,
        name: &str,
        decide: impl FnOnce(Option<PropertyDefinition>) -> Result<(Next, T), DefinitionsError>,
    ) -> Result<T, DefinitionsError> {
        let name = named(name)?;
        let _turn = TURN.lock().unwrap_or_else(PoisonError::into_inner);
        let stored: Option<StoredDefinition> = self
            .records
            .list()?
            .into_iter()
            .find(|stored| stored.record.name == name);
        let synced = stored
            .as_ref()
            .and_then(|stored| definition_of(&stored.record));
        let (next, out) = properties_file::update(&self.vault, |definitions| {
            let current = definitions.get(name).cloned().or(synced);
            let (next, out) = decide(current)?;
            match &next {
                Next::Put(definition) => definitions.insert(name.to_owned(), definition.clone()),
                Next::Remove => drop(definitions.remove(name)),
                Next::Keep => {}
            }
            Ok::<_, DefinitionsError>((next, out))
        })??;
        match next {
            Next::Put(definition) => {
                self.records.put(&record_of(name, &definition), now_ms())?;
            }
            Next::Remove if stored.is_some() => {
                self.records.remove(name, now_ms())?;
            }
            Next::Remove | Next::Keep => {}
        }
        Ok(out)
    }

    fn view(&self, name: &str) -> Result<Option<PropertyDefinitionView>, DefinitionsError> {
        Ok(self.list()?.into_iter().find(|view| view.name == name))
    }

    /// `notes:create-property-definition`: over an existing name it keeps what the new type
    /// shares with the old one, and the color whatever the type.
    pub fn create(
        &self,
        input: DefinitionInput,
    ) -> Result<Option<PropertyDefinitionView>, DefinitionsError> {
        let wanted = editable(input.type_name)?
            .ok_or(DefinitionsError::Invalid("a new property needs a type"))?;
        self.change(&input.name, |existing| {
            let same = existing
                .as_ref()
                .filter(|definition| type_of(&definition.kind) == wanted);
            let definition = PropertyDefinition {
                kind: kind_of(wanted, input.options, same.map(|same| &same.kind)),
                default_value: filled(
                    input
                        .default_value
                        .or_else(|| same.and_then(|same| same.default_value.clone())),
                ),
                color: filled(
                    input
                        .color
                        .or_else(|| existing.as_ref().and_then(|e| e.color.clone())),
                ),
            };
            Ok((Next::Put(definition), ()))
        })?;
        self.view(&input.name)
    }

    /// `notes:update-property-definition`. `None` when there is no definition of the name.
    pub fn update(
        &self,
        input: DefinitionInput,
    ) -> Result<Option<PropertyDefinitionView>, DefinitionsError> {
        let named = editable(input.type_name)?;
        let found = self.change(&input.name, |existing| {
            let Some(existing) = existing else {
                return Ok((Next::Keep, false));
            };
            let wanted = named.unwrap_or_else(|| type_of(&existing.kind));
            let definition = PropertyDefinition {
                kind: kind_of(wanted, input.options, Some(&existing.kind)),
                default_value: filled(input.default_value.or(existing.default_value)),
                color: filled(input.color.or(existing.color)),
            };
            Ok((Next::Put(definition), true))
        })?;
        if found {
            self.view(&input.name)
        } else {
            Ok(None)
        }
    }

    /// `notes:ensure-property-definition`: a name that already has the type is left alone;
    /// otherwise it takes the type, with the default status categories or its option list.
    pub fn ensure(&self, name: &str, wanted: EnsuredType) -> Result<(), DefinitionsError> {
        self.change(name, |existing| {
            let kind = match (wanted, existing.as_ref().map(|e| &e.kind)) {
                (EnsuredType::Status, Some(PropertyKind::Status(_)))
                | (EnsuredType::Select, Some(PropertyKind::Select(_)))
                | (EnsuredType::Multiselect, Some(PropertyKind::Multiselect(_))) => {
                    return Ok((Next::Keep, ()));
                }
                (EnsuredType::Status, _) => PropertyKind::Status(default_categories()),
                (list_type, prior) => {
                    let options = options_of(prior);
                    match list_type {
                        EnsuredType::Multiselect => PropertyKind::Multiselect(options),
                        _ => PropertyKind::Select(options),
                    }
                }
            };
            let color = existing.and_then(|existing| existing.color);
            Ok((
                Next::Put(PropertyDefinition {
                    kind,
                    default_value: None,
                    color,
                }),
                (),
            ))
        })
    }

    /// `notes:add-property-option`. A name with no definition becomes a select with the option;
    /// a value the list has already, or a type without an option list, is left as it is.
    pub fn add_option(&self, name: &str, input: OptionInput) -> Result<(), DefinitionsError> {
        let added = new_option(input)?;
        self.change(name, |existing| {
            let Some(mut definition) = existing else {
                let definition = PropertyDefinition {
                    kind: PropertyKind::Select(vec![added]),
                    default_value: None,
                    color: None,
                };
                return Ok((Next::Put(definition), ()));
            };
            match option_list(&mut definition.kind) {
                Some(list) if list.iter().all(|o| o.value != added.value) => list.push(added),
                _ => return Ok((Next::Keep, ())),
            }
            Ok((Next::Put(definition), ()))
        })
    }

    /// `notes:add-status-option`. A name with no definition becomes a status with the default
    /// categories plus the option.
    pub fn add_status_option(
        &self,
        name: &str,
        category: StatusCategoryKey,
        input: OptionInput,
    ) -> Result<(), DefinitionsError> {
        let added = new_option(input)?;
        self.change(name, |existing| {
            let (mut categories, default_value, color): (StatusCategories, _, _) = match existing {
                None => (default_categories(), None, None),
                Some(PropertyDefinition {
                    kind: PropertyKind::Status(categories),
                    default_value,
                    color,
                }) => (categories, default_value, color),
                Some(_) => return Err(DefinitionsError::NotStatus(name.to_owned())),
            };
            let target = match category {
                StatusCategoryKey::Todo => &mut categories.todo,
                StatusCategoryKey::InProgress => &mut categories.in_progress,
                StatusCategoryKey::Done => &mut categories.done,
            };
            if target.options.iter().any(|o| o.value == added.value) {
                return Ok((Next::Keep, ()));
            }
            target.options.push(added);
            let definition = PropertyDefinition {
                kind: PropertyKind::Status(categories),
                default_value,
                color,
            };
            Ok((Next::Put(definition), ()))
        })
    }

    /// Changes every option list of an existing definition.
    fn edit_options(
        &self,
        name: &str,
        change: impl FnMut(&mut Vec<SelectOption>),
    ) -> Result<(), DefinitionsError> {
        self.change(name, |existing| {
            let mut definition =
                existing.ok_or_else(|| DefinitionsError::NotFound(name.to_owned()))?;
            each_list(&mut definition.kind, change);
            Ok((Next::Put(definition), ()))
        })
    }

    /// `notes:remove-property-option`. Note values keep the option.
    pub fn remove_option(&self, name: &str, value: &str) -> Result<(), DefinitionsError> {
        self.edit_options(name, |list| list.retain(|o| o.value != value))
    }

    /// `notes:rename-property-option`. Note values keep the old name, as in Electron.
    pub fn rename_option(&self, name: &str, old: &str, new: &str) -> Result<(), DefinitionsError> {
        if new.is_empty() {
            return Err(DefinitionsError::Invalid("an option needs a value"));
        }
        self.edit_options(name, |list| {
            for option in list.iter_mut().filter(|o| o.value == old) {
                new.clone_into(&mut option.value);
            }
        })
    }

    /// `notes:update-option-color`.
    pub fn set_option_color(
        &self,
        name: &str,
        value: &str,
        color: &str,
    ) -> Result<(), DefinitionsError> {
        if color.is_empty() {
            return Err(DefinitionsError::Invalid("an option needs a color"));
        }
        self.edit_options(name, |list| {
            for option in list.iter_mut().filter(|o| o.value == value) {
                color.clone_into(&mut option.color);
            }
        })
    }

    /// `notes:delete-property-definition`: out of the file and the record tombstoned. Note
    /// values keep the property.
    pub fn delete(&self, name: &str) -> Result<(), DefinitionsError> {
        self.change(name, |_| Ok((Next::Remove, ())))
    }

    /// `notes:set-calendar-property-visibility`. Showing makes the name a date property;
    /// hiding a date that carries nothing else removes its definition.
    pub fn set_show_on_calendar(&self, name: &str, show: bool) -> Result<(), DefinitionsError> {
        self.change(name, |existing| {
            let next = match existing {
                Some(PropertyDefinition {
                    kind: PropertyKind::Date { .. },
                    default_value: None,
                    color: None,
                }) if !show => Next::Remove,
                Some(mut definition) => {
                    match &mut definition.kind {
                        PropertyKind::Date { show_on_calendar } => *show_on_calendar = show,
                        _ if show => {
                            definition = PropertyDefinition {
                                kind: PropertyKind::Date {
                                    show_on_calendar: true,
                                },
                                default_value: None,
                                color: None,
                            };
                        }
                        _ => {}
                    }
                    Next::Put(definition)
                }
                None if show => Next::Put(PropertyDefinition {
                    kind: PropertyKind::Date {
                        show_on_calendar: true,
                    },
                    default_value: None,
                    color: None,
                }),
                None => Next::Keep,
            };
            Ok((next, ()))
        })
    }
}
