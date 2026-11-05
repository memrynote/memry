//! Property definitions (#3530 Step 13k): the definition and option commands of
//! `ipc/notes-handlers.ts` over `PropertyDefinitionsService` (`vault/property-definitions.ts`).
//!
//! Two stores hold the definitions. `.memry/properties.md` ([`properties_file`]) is the one
//! people edit and older builds share; the synced `property_definition` records are the ones
//! other devices see. The app shows their union, the file winning for every name it lists, as
//! Electron's reload folds the synced rows into what the file holds.
//!
//! The file is kept from shadowing a newer record: before the file is read for a list or an
//! edit, every record a pull changed since the file last took it is written into the file
//! ([`settle`], Electron's `applyRemoteUpsert` / `applyRemoteDelete`, #2896). A pull that
//! lands while an edit runs is taken the same way, and the edit is decided again over it.
//!
//! Every edit runs in one turn: it settles the file, reads the union's definition of the name,
//! writes the file through [`properties_file::update`], then makes the record equal to what
//! the file now holds, as Electron's rebuild of its rows and `enqueuePropertyDefinitionUpsert`
//! do, keeping the keys of the record's opaque `options` this build does not read (#3844). A
//! file that cannot be read refuses the edit, and neither store changes. When the record write
//! fails after the file was written, the error reaches the caller and the next edit of the
//! name writes the record again. A date's calendar flag lives only in this device's file.
//!
//! The note index types its rows by these definitions and retypes them when one changes type
//! (`retypeIndexedProperties`), and gives a property it reads with no definition one
//! ([`PropertyDefinitions::learn`]; `notes::index`).

mod kind;
mod record;
mod settle;
mod view;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::AuthError;
use memry_core::api::errors::StorageError;
use memry_core::domain::property_admin::mirror::{Edit, Written};
use memry_core::domain::property_admin::records::DefinitionRecords;
use memry_core::seams::secure_store::SecureStore;

use crate::session::OpenVault;
use crate::vault::consumer::rows::now_ms;
use crate::vault::properties_file::{
    self, PropertyDefinition, PropertyKind, SelectOption, StatusCategories,
};
use kind::{each_list, kind_of, new_option, option_list, options_of, type_of};
use record::{Renamed, default_categories, definition_of, options_text, record_of};
use settle::settle_into;
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

/// How often an edit is decided again over a pull that landed while it ran.
const ATTEMPTS: usize = 3;

fn named(name: &str) -> Result<&str, DefinitionsError> {
    if name.is_empty() {
        return Err(DefinitionsError::Invalid("a property needs a name"));
    }
    Ok(name)
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
    /// Test hook: runs once the file holds an edit, before its record is written.
    between: Mutex<Option<Box<dyn FnMut() + Send>>>,
}

impl PropertyDefinitions {
    pub fn new(vault: PathBuf, records: DefinitionRecords) -> Self {
        Self {
            vault,
            records,
            between: Mutex::new(None),
        }
    }

    #[doc(hidden)]
    pub fn before_record_write(&self, hook: impl FnMut() + Send + 'static) {
        *self.between.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(hook));
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
        if let Err(error) = self.settle() {
            tracing::warn!(
                scope = "PropertyDefinitions",
                "pulled definitions are not in the file yet: {error}"
            );
        }
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

    /// Writes every record a pull changed since the file took it into the file. Returns the
    /// names whose definition the file changed. The list does this before it reads, and so
    /// does every edit; a caller that learns of a pull (the sync driver) can do it at once.
    pub fn settle(&self) -> Result<Vec<String>, DefinitionsError> {
        let _turn = TURN.lock().unwrap_or_else(PoisonError::into_inner);
        let snapshot = self.records.snapshot()?;
        let pulled = snapshot.pulled();
        if pulled.is_empty() {
            return Ok(Vec::new());
        }
        let changed =
            properties_file::update(&self.vault, |definitions| settle_into(definitions, &pulled))?;
        self.records.take(&snapshot)?;
        Ok(changed)
    }

    /// One edit of `name`'s definition: `decide` gets the union's definition and says what
    /// becomes of it. It runs again over a pull that changed the record meanwhile.
    fn change<T>(
        &self,
        name: &str,
        decide: impl FnMut(Option<PropertyDefinition>) -> Result<(Next, T), DefinitionsError>,
    ) -> Result<T, DefinitionsError> {
        self.change_renaming(name, None, decide)
    }

    /// [`Self::change`] of an edit that renames the option `renamed` (its old value), which
    /// keeps its record entry.
    fn change_renaming<T>(
        &self,
        name: &str,
        renamed: Option<&str>,
        mut decide: impl FnMut(Option<PropertyDefinition>) -> Result<(Next, T), DefinitionsError>,
    ) -> Result<T, DefinitionsError> {
        let name = named(name)?;
        let _turn = TURN.lock().unwrap_or_else(PoisonError::into_inner);
        for _ in 0..ATTEMPTS {
            let snapshot = self.records.snapshot()?;
            let pulled = snapshot.pulled();
            let prior = snapshot.record(name);
            let mut before = None;
            let (next, out) = properties_file::update(&self.vault, |definitions| {
                settle_into(definitions, &pulled);
                let synced = prior.and_then(definition_of);
                let current = definitions.get(name).cloned().or(synced);
                before = current.as_ref().map(|current| current.kind.clone());
                let (next, out) = decide(current)?;
                match &next {
                    Next::Put(definition) => {
                        definitions.insert(name.to_owned(), definition.clone());
                    }
                    Next::Remove => drop(definitions.remove(name)),
                    Next::Keep => {}
                }
                Ok::<_, DefinitionsError>((next, out))
            })??;
            let edit = match next {
                Next::Put(definition) => {
                    let renamed: Renamed<'_> = renamed.zip(before.as_ref());
                    Edit::Put(record_of(name, &definition, prior, renamed))
                }
                Next::Remove => Edit::Remove,
                Next::Keep => Edit::Keep,
            };
            if let Some(between) = self
                .between
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .as_mut()
            {
                between();
            }
            match self.records.write(&snapshot, name, &edit, now_ms())? {
                Written::Done => return Ok(out),
                Written::Unrecorded(error) => {
                    tracing::warn!(
                        scope = "PropertyDefinitions",
                        name,
                        "the edit landed; recording what the file holds failed: {error}"
                    );
                    return Ok(out);
                }
                Written::Moved => tracing::info!(
                    scope = "PropertyDefinitions",
                    name,
                    "a pull changed the definition during the edit; deciding again over it"
                ),
            }
        }
        Err(StorageError::Failed {
            what: format!("the definition of {name} kept changing on another device"),
        }
        .into())
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
                kind: kind_of(wanted, input.options.clone(), same.map(|same| &same.kind)),
                default_value: filled(
                    input
                        .default_value
                        .clone()
                        .or_else(|| same.and_then(|same| same.default_value.clone())),
                ),
                color: filled(
                    input
                        .color
                        .clone()
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
                kind: kind_of(wanted, input.options.clone(), Some(&existing.kind)),
                default_value: filled(input.default_value.clone().or(existing.default_value)),
                color: filled(input.color.clone().or(existing.color)),
            };
            Ok((Next::Put(definition), true))
        })?;
        if found {
            self.view(&input.name)
        } else {
            Ok(None)
        }
    }

    /// `learnCanonicalPropertyType`: a property with no definition takes one of `wanted`, the
    /// type its value was first read with. A definition there already is left as it is, but
    /// for `project`, whose type is always its own. `true` when it wrote one.
    pub fn learn(&self, name: &str, wanted: DefinitionType) -> Result<bool, DefinitionsError> {
        self.change(name, |existing| {
            let kept = existing.as_ref().is_some_and(|existing| {
                wanted != DefinitionType::Project || type_of(&existing.kind) == wanted
            });
            if kept {
                return Ok((Next::Keep, false));
            }
            let definition = PropertyDefinition {
                kind: kind_of(wanted, None, None),
                default_value: existing.as_ref().and_then(|e| e.default_value.clone()),
                color: existing.and_then(|existing| existing.color),
            };
            Ok((Next::Put(definition), true))
        })
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
                    kind: PropertyKind::Select(vec![added.clone()]),
                    default_value: None,
                    color: None,
                };
                return Ok((Next::Put(definition), ()));
            };
            match option_list(&mut definition.kind) {
                Some(list) if list.iter().all(|o| o.value != added.value) => {
                    list.push(added.clone());
                }
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
            target.options.push(added.clone());
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
        renamed: Option<&str>,
        mut change: impl FnMut(&mut Vec<SelectOption>),
    ) -> Result<(), DefinitionsError> {
        self.change_renaming(name, renamed, |existing| {
            let mut definition =
                existing.ok_or_else(|| DefinitionsError::NotFound(name.to_owned()))?;
            each_list(&mut definition.kind, &mut change);
            Ok((Next::Put(definition), ()))
        })
    }

    /// `notes:remove-property-option`. Note values keep the option.
    pub fn remove_option(&self, name: &str, value: &str) -> Result<(), DefinitionsError> {
        self.edit_options(name, None, |list| list.retain(|o| o.value != value))
    }

    /// `notes:rename-property-option`. Note values keep the old name, as in Electron.
    pub fn rename_option(&self, name: &str, old: &str, new: &str) -> Result<(), DefinitionsError> {
        if new.is_empty() {
            return Err(DefinitionsError::Invalid("an option needs a value"));
        }
        self.edit_options(name, Some(old), |list| {
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
        self.edit_options(name, None, |list| {
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
