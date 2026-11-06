//! The schema commands' inputs and answers as the renderer sees them
//! (`packages/contracts/src/tag-schema-api.ts`, `tag-schema.ts`).

use std::collections::BTreeMap;

use memry_core::domain::tag_schema::{
    InheritedFields, Relation, ResolvedField, ResolvedTag, ResolvedTemplate,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::rename::FieldRenameView;

/// `RelationConfig`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RelationView {
    pub target: Option<String>,
    pub many: bool,
    pub inverse: Option<String>,
}

impl From<&Relation> for RelationView {
    fn from(relation: &Relation) -> Self {
        Self {
            target: relation.target.clone(),
            many: relation.many,
            inverse: relation.inverse.clone(),
        }
    }
}

/// `SelectOption`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SelectOptionView {
    pub value: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = bool)]
    pub default: Option<bool>,
}

/// `ResolvedField`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFieldView {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: FieldType,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = Vec<SelectOptionView>)]
    pub options: Option<Vec<SelectOptionView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = bool)]
    pub show_on_calendar: Option<bool>,
    pub relation: Option<RelationView>,
    pub defined_by: String,
}

impl From<&ResolvedField> for ResolvedFieldView {
    fn from(field: &ResolvedField) -> Self {
        Self {
            name: field.name.clone(),
            type_name: FieldType::of(&field.type_name),
            // An option list this build cannot read is left out, as a status's categories are.
            options: field
                .options
                .clone()
                .and_then(|options| serde_json::from_value(options).ok()),
            show_on_calendar: field.show_on_calendar,
            relation: field.relation.as_ref().map(RelationView::from),
            defined_by: field.defined_by.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct InheritedFieldsView {
    pub from: String,
    pub fields: Vec<ResolvedFieldView>,
}

impl From<&InheritedFields> for InheritedFieldsView {
    fn from(group: &InheritedFields) -> Self {
        Self {
            from: group.from.clone(),
            fields: group.fields.iter().map(ResolvedFieldView::from).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTemplateView {
    pub id: String,
    pub autofill: bool,
    pub inherited_from: Option<String>,
}

impl From<&ResolvedTemplate> for ResolvedTemplateView {
    fn from(template: &ResolvedTemplate) -> Self {
        Self {
            id: template.id.clone(),
            autofill: template.autofill,
            inherited_from: template.inherited_from.clone(),
        }
    }
}

/// `ResolvedTag`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTagView {
    pub name: String,
    pub key: String,
    pub color: String,
    pub icon: Option<String>,
    pub editable: bool,
    pub own_fields: Vec<ResolvedFieldView>,
    pub inherited: Vec<InheritedFieldsView>,
    pub effective_fields: Vec<ResolvedFieldView>,
    pub has_fields: bool,
    pub extends: Option<String>,
    pub ancestors: Vec<String>,
    pub template: Option<ResolvedTemplateView>,
    pub preset: Option<PresetKey>,
    pub own_preset: Option<PresetKey>,
}

impl From<&ResolvedTag> for ResolvedTagView {
    fn from(tag: &ResolvedTag) -> Self {
        let fields =
            |fields: &[ResolvedField]| fields.iter().map(ResolvedFieldView::from).collect();
        Self {
            name: tag.name.clone(),
            key: tag.key.clone(),
            color: tag.color.clone(),
            icon: tag.icon.clone(),
            editable: tag.editable,
            own_fields: fields(&tag.own_fields),
            inherited: tag
                .inherited
                .iter()
                .map(InheritedFieldsView::from)
                .collect(),
            effective_fields: fields(&tag.effective_fields),
            has_fields: tag.has_fields,
            extends: tag.extends.clone(),
            ancestors: tag.ancestors.clone(),
            template: tag.template.as_ref().map(ResolvedTemplateView::from),
            preset: tag.preset.as_deref().and_then(PresetKey::of),
            own_preset: tag.own_preset.as_deref().and_then(PresetKey::of),
        }
    }
}

/// One field of a preset offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PresetOfferFieldView {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: FieldType,
    pub relation_target: Option<String>,
}

/// `PresetOffer.state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PresetState {
    Add,
    AddFields,
    Added,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct ExistingTagView {
    pub key: String,
    pub usage: u32,
}

/// `PresetOffer`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PresetOfferView {
    pub key: PresetKey,
    pub name: String,
    pub icon: Option<String>,
    pub color: String,
    pub fields: Vec<PresetOfferFieldView>,
    pub template_sections: Vec<String>,
    pub state: PresetState,
    pub existing_tag: Option<ExistingTagView>,
    pub also_adds: Vec<String>,
}

/// `TagSchemaSnapshot`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagSchemaSnapshotView {
    /// Tag key to its resolved schema; only tags with a schema.
    pub tags: BTreeMap<String, ResolvedTagView>,
    /// Note id to its primary object tag key.
    pub objects: BTreeMap<String, String>,
    pub presets: Vec<PresetOfferView>,
    pub preset_strip_dismissed: bool,
}

/// `FieldType`: every property type but `project`, which is also every type a new field may get
/// (`NEW_FIELD_TYPES`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    Text,
    Number,
    Checkbox,
    Date,
    Url,
    Status,
    Select,
    Multiselect,
    Relation,
}

impl FieldType {
    /// The resolver's type name; a type this build does not know reads as text.
    fn of(name: &str) -> Self {
        serde_json::from_value(Value::String(name.to_owned())).unwrap_or(Self::Text)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Checkbox => "checkbox",
            Self::Date => "date",
            Self::Url => "url",
            Self::Status => "status",
            Self::Select => "select",
            Self::Multiselect => "multiselect",
            Self::Relation => "relation",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
pub struct FieldOptionInput {
    pub value: String,
    pub color: String,
}

/// `NewFieldSpec`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
pub struct NewFieldSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: FieldType,
    #[serde(default)]
    pub options: Option<Vec<FieldOptionInput>>,
    #[serde(default)]
    pub relation: Option<RelationView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
pub struct TemplateChoice {
    pub id: String,
    pub autofill: bool,
}

/// `TagSchemaCommand`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TagSchemaCommand {
    #[serde(rename_all = "camelCase")]
    AddField {
        tag: String,
        field: NewFieldSpec,
        #[serde(default)]
        index: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    SetRelation {
        tag: String,
        name: String,
        relation: RelationView,
    },
    #[serde(rename_all = "camelCase")]
    RemoveField {
        tag: String,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    MoveField {
        tag: String,
        name: String,
        to_index: u32,
    },
    #[serde(rename_all = "camelCase")]
    SetTemplate {
        tag: String,
        template: Option<TemplateChoice>,
    },
    #[serde(rename_all = "camelCase")]
    SetExtends {
        tag: String,
        parent: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    AddPreset {
        preset: PresetKey,
        #[serde(default)]
        tag: Option<String>,
    },
    // Vault-wide: a field name is a property key. `runId` names its progress events. A doc comment
    // here would put trailing whitespace into the generated union.
    #[serde(rename_all = "camelCase")]
    RenameField {
        from: String,
        to: String,
        run_id: String,
    },
    DismissPresetOffer,
}

/// `PRESET_KEYS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum PresetKey {
    Person,
    Company,
    Meeting,
    Book,
}

impl PresetKey {
    fn of(name: &str) -> Option<Self> {
        serde_json::from_value(Value::String(name.to_owned())).ok()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Company => "company",
            Self::Meeting => "meeting",
            Self::Book => "book",
        }
    }
}

/// `TagSchemaCommandResult`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagSchemaCommandResultView {
    pub snapshot: TagSchemaSnapshotView,
    /// The tag `add-preset` wrote.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = String)]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = FieldRenameView)]
    pub rename: Option<FieldRenameView>,
}
