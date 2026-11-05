//! The schema commands (`runTagSchemaCommand`): each edit checked at the boundary, refused in
//! the UI language, and written through the core's schema writer. A new field's property
//! definition is written first, through its owner (`PropertyDefinitions`).

use memry_core::api::errors::StorageError;
use memry_core::domain::tag_schema::edit::canonical_field_name;
use memry_core::domain::tag_schema::{
    self, NewField, Relation, SaveError, SchemaEdit, SchemaEditError,
};
use memry_core::domain::tags::tag_key;

use super::view::{
    FieldType, NewFieldSpec, RelationView, TagSchemaCommand, TagSchemaCommandResultView,
    TemplateChoice,
};
use super::{SchemaError, Schemas};
use crate::i18n::{self, Arg, Args};
use crate::notes::property_definitions::{DefinitionInput, DefinitionType, OptionInput};

/// What a command wrote besides the schema, for the events the shell sends after it.
#[derive(Debug, Default)]
pub struct Effects {
    /// Property definitions the command created (`properties:definition-changed`).
    pub definitions: Vec<String>,
    /// Templates the command created (`templates:created`).
    pub templates: Vec<String>,
}

/// What a command did.
#[derive(Debug)]
pub struct Ran {
    pub result: TagSchemaCommandResultView,
    /// A schema may have changed: the tag list and every tag schema reader refetch
    /// (`notes:tags-changed`).
    pub tags_changed: bool,
    pub effects: Effects,
}

impl Schemas {
    fn refused(&self, code: &'static str, key: &str, args: &[(&str, &str)]) -> SchemaError {
        let args: Args = args
            .iter()
            .map(|(name, value)| ((*name).to_owned(), Arg::from(*value)))
            .collect();
        SchemaError::Refused {
            code,
            message: i18n::t(&self.locale, key, &args),
        }
    }

    /// `schemaEditFailure`.
    fn edit_refused(&self, error: SchemaEditError) -> SchemaError {
        let key = |k: &str| format!("errors:tagFields.{k}");
        match error {
            SchemaEditError::ReservedName { name } => self.refused(
                "tag_field_reserved_name",
                &key("reservedName"),
                &[("name", &name)],
            ),
            SchemaEditError::DuplicateField { name, defined_by } => self.refused(
                "tag_field_duplicate",
                &key("duplicateField"),
                &[("name", &name), ("definedBy", &defined_by)],
            ),
            SchemaEditError::UnknownField { name } => self.refused(
                "tag_field_unknown",
                &key("unknownField"),
                &[("name", &name)],
            ),
            SchemaEditError::InheritedField { name, defined_by } => self.refused(
                "tag_field_inherited",
                &key("inheritedField"),
                &[("name", &name), ("definedBy", &defined_by)],
            ),
            SchemaEditError::Cycle { parent } => {
                self.refused("tag_schema_cycle", &key("cycle"), &[("parent", &parent)])
            }
            SchemaEditError::UnreadableSchema => {
                self.refused("tag_schema_unreadable", &key("unreadableSchema"), &[])
            }
            // Only input the boundary did not check gets here; Electron's zod errors are English.
            SchemaEditError::Unwritable => StorageError::Invalid {
                what: "the tag schema this edit makes could not be read back".to_owned(),
            }
            .into(),
        }
    }

    fn saved(&self, error: SaveError) -> SchemaError {
        match error {
            SaveError::Storage(error) => error.into(),
            SaveError::Edit(error) => self.edit_refused(error),
        }
    }

    /// `tags:edit-schema` (`runTagSchemaCommand`), then the snapshot after it.
    pub fn run(&self, command: TagSchemaCommand) -> Result<Ran, SchemaError> {
        let mut effects = Effects::default();
        let mut tag = None;
        let tags_changed = match command {
            TagSchemaCommand::AddField {
                tag: name,
                field,
                index,
            } => self.add_field(&tag_name(&name)?, field, index, &mut effects)?,
            TagSchemaCommand::SetRelation {
                tag: name,
                name: field,
                relation,
            } => self.save(
                &tag_name(&name)?,
                &SchemaEdit::SetRelation {
                    name: field_name(&field)?,
                    relation: Some(relation_config(&relation)?),
                },
            )?,
            TagSchemaCommand::RemoveField {
                tag: name,
                name: field,
            } => self.save(
                &tag_name(&name)?,
                &SchemaEdit::RemoveField {
                    name: field_name(&field)?,
                },
            )?,
            TagSchemaCommand::MoveField {
                tag: name,
                name: field,
                to_index,
            } => self.save(
                &tag_name(&name)?,
                &SchemaEdit::MoveField {
                    name: field_name(&field)?,
                    to_index: to_index as usize,
                },
            )?,
            TagSchemaCommand::SetTemplate {
                tag: name,
                template,
            } => self.save(
                &tag_name(&name)?,
                &SchemaEdit::SetTemplate {
                    template: template.map(template_choice).transpose()?,
                },
            )?,
            TagSchemaCommand::SetExtends { tag: name, parent } => {
                let parent = parent.as_deref().map(tag_name).transpose()?;
                self.save(&tag_name(&name)?, &SchemaEdit::SetExtends { parent })?
            }
            TagSchemaCommand::AddPreset { preset, tag: name } => {
                let name = name.as_deref().map(tag_name).transpose()?;
                let mut adding = Vec::new();
                tag = Some(self.add_preset(preset, name.as_deref(), &mut adding, &mut effects)?);
                true
            }
            TagSchemaCommand::DismissPresetOffer => {
                self.schemas.dismiss_preset_offer()?;
                true
            }
        };
        Ok(Ran {
            result: TagSchemaCommandResultView {
                snapshot: self.snapshot()?,
                tag,
            },
            tags_changed,
            effects,
        })
    }

    /// `saveSchemaEdit`: `true` when the stored schema changed.
    pub(super) fn save(&self, tag: &str, edit: &SchemaEdit) -> Result<bool, SchemaError> {
        Ok(self
            .schemas
            .save(tag, edit)
            .map_err(|error| self.saved(error))?
            .changed)
    }

    /// Refuses `edit` before anything is written, as `planSchemaEdit` does.
    fn plan(&self, tag: &str, edit: &SchemaEdit) -> Result<(), SchemaError> {
        let resolved = self.resolved()?;
        let key = tag_key(tag);
        let definitions = self.open.vault.tag_schema_definitions()?;
        let current = match definitions.get(&key).and_then(|d| d.schema.as_ref()) {
            Some(tag_schema::StoredSchema::Unreadable) => {
                return Err(self.edit_refused(SchemaEditError::UnreadableSchema));
            }
            Some(tag_schema::StoredSchema::Readable(schema)) => Some(schema),
            None => None,
        };
        tag_schema::edit::apply(current, edit, &key, &resolved)
            .map(|_| ())
            .map_err(|error| self.edit_refused(error))
    }

    /// `fieldNameFor`: the spelling a property or a field of the same name already has.
    pub(super) fn field_name_for(&self, typed: &str) -> Result<String, SchemaError> {
        let mut known: Vec<String> = self
            .definitions
            .list()?
            .into_iter()
            .map(|d| d.name)
            .collect();
        for tag in self.resolved()?.values() {
            known.extend(tag.own_fields.iter().map(|f| f.name.clone()));
        }
        Ok(canonical_field_name(typed, known.iter().map(String::as_str)).0)
    }

    /// `ensureFieldDefinition`: a name with no definition gets one of the field's type.
    pub(super) fn ensure_definition(
        &self,
        name: &str,
        type_name: FieldType,
        options: Vec<OptionInput>,
        show_on_calendar: bool,
        effects: &mut Effects,
    ) -> Result<(), SchemaError> {
        let Some(wanted) = definition_type(type_name) else {
            return Ok(());
        };
        if self.definitions.list()?.iter().any(|d| d.name == name) {
            return Ok(());
        }
        if show_on_calendar && wanted == DefinitionType::Date {
            self.definitions.set_show_on_calendar(name, true)?;
        } else {
            self.definitions.create(DefinitionInput {
                name: name.to_owned(),
                type_name: Some(wanted),
                options: (!options.is_empty()).then_some(options),
                default_value: None,
                color: None,
            })?;
        }
        effects.definitions.push(name.to_owned());
        Ok(())
    }

    /// `addField`.
    fn add_field(
        &self,
        tag: &str,
        spec: NewFieldSpec,
        index: Option<u32>,
        effects: &mut Effects,
    ) -> Result<bool, SchemaError> {
        let relation = match (spec.type_name, &spec.relation) {
            (FieldType::Relation, None) => {
                return Err(self.refused(
                    "tag_field_relation_target_required",
                    "errors:tagFields.relationTargetRequired",
                    &[],
                ));
            }
            (FieldType::Relation, Some(relation)) => Some(relation_config(relation)?),
            _ => None,
        };
        let name = self.field_name_for(&field_name(&spec.name)?)?;
        let edit = SchemaEdit::AddField {
            field: NewField {
                name: name.clone(),
                relation,
            },
            index: index.map(|i| i as usize),
        };
        self.plan(tag, &edit)?;
        let options = spec
            .options
            .unwrap_or_default()
            .into_iter()
            .map(|o| OptionInput {
                value: o.value,
                color: o.color,
                default: None,
            })
            .collect();
        self.ensure_definition(&name, spec.type_name, options, false, effects)?;
        self.save(tag, &edit)
    }
}

/// `TagName` (`z.string().trim().min(1).max(50)`).
fn tag_name(tag: &str) -> Result<String, SchemaError> {
    let tag = tag.trim();
    if tag.is_empty() || length(tag) > 50 {
        return Err(StorageError::Invalid {
            what: "a tag name must be 1 to 50 characters".to_owned(),
        }
        .into());
    }
    Ok(tag.to_owned())
}

/// `RelationConfigSchema`: a target, when set, is a `TagName`; the inverse label is trimmed and at
/// most 100 characters.
fn relation_config(view: &RelationView) -> Result<Relation, SchemaError> {
    let inverse = view.inverse.as_deref().map(str::trim);
    if inverse.is_some_and(|label| length(label) > 100) {
        return Err(StorageError::Invalid {
            what: "a relation label must be at most 100 characters".to_owned(),
        }
        .into());
    }
    Ok(Relation {
        target: view.target.as_deref().map(tag_name).transpose()?,
        many: view.many,
        inverse: inverse.map(str::to_owned),
    })
}

/// `template` of `set-template` (`{ id: z.string().min(1), autofill }`).
fn template_choice(choice: TemplateChoice) -> Result<(String, bool), SchemaError> {
    if choice.id.is_empty() {
        return Err(StorageError::Invalid {
            what: "a template id must not be empty".to_owned(),
        }
        .into());
    }
    Ok((choice.id, choice.autofill))
}

/// `FieldName` (`z.string().trim().min(1).max(200)`).
fn field_name(name: &str) -> Result<String, SchemaError> {
    let name = name.trim();
    if name.is_empty() || length(name) > 200 {
        return Err(StorageError::Invalid {
            what: "a field name must be 1 to 200 characters".to_owned(),
        }
        .into());
    }
    Ok(name.to_owned())
}

fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The definition type a field of `type_name` gets; a relation gets none.
fn definition_type(type_name: FieldType) -> Option<DefinitionType> {
    Some(match type_name {
        FieldType::Text => DefinitionType::Text,
        FieldType::Number => DefinitionType::Number,
        FieldType::Checkbox => DefinitionType::Checkbox,
        FieldType::Date => DefinitionType::Date,
        FieldType::Url => DefinitionType::Url,
        FieldType::Status => DefinitionType::Status,
        FieldType::Select => DefinitionType::Select,
        FieldType::Multiselect => DefinitionType::Multiselect,
        FieldType::Relation => return None,
    })
}
