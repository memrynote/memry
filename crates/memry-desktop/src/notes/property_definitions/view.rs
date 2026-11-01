//! What the definition commands take and give back, and how they fail.

use memry_core::api::errors::{AuthError, StorageError};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, FailureKind};
use crate::vault::properties_file::PropertiesFileError;

/// A definition as the renderer reads it (`PropertyDefinition` of `@memry/rpc`): what Electron's
/// `property_definitions` row holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinitionView {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: DefinitionType,
    /// JSON text: the option list, or `{"categories": …}` for a status.
    pub options: Option<String>,
    pub default_value: Option<String>,
    pub color: Option<String>,
    /// When the record was created; empty for a definition only the file holds.
    pub created_at: String,
}

/// The types a definition holds. A create or an update takes every one but `project`
/// (`PROPERTY_TYPE_ENUM`), which is system-managed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DefinitionType {
    Text,
    Number,
    Checkbox,
    Date,
    Url,
    Status,
    Select,
    Multiselect,
    Project,
}

/// The types `notes:ensure-property-definition` creates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum EnsuredType {
    Status,
    Select,
    Multiselect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum StatusCategoryKey {
    Todo,
    InProgress,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
pub struct OptionInput {
    pub value: String,
    pub color: String,
    #[serde(default)]
    pub default: Option<bool>,
}

/// `CreatePropertyDefinitionSchema`, and `UpdatePropertyDefinitionSchema` with `type` left out.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionInput {
    pub name: String,
    #[serde(default, rename = "type")]
    pub type_name: Option<DefinitionType>,
    #[serde(default)]
    pub options: Option<Vec<OptionInput>>,
    /// Already text: the renderer's service turns any other value into text as Electron's
    /// `stringifyDefaultValue` does.
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum DefinitionsError {
    #[error("No property definition named \"{0}\"")]
    NotFound(String),
    #[error("Property \"{0}\" is not a status property")]
    NotStatus(String),
    #[error("{0}")]
    Invalid(&'static str),
    #[error(transparent)]
    File(#[from] PropertiesFileError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Auth(#[from] AuthError),
}

impl CoreError for DefinitionsError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::NotFound(_) => (FailureKind::NotFound, "property_definition_not_found"),
            Self::NotStatus(_) => (FailureKind::Invalid, "property_not_status"),
            Self::Invalid(_) => (FailureKind::Invalid, "invalid"),
            Self::File(PropertiesFileError::Unreadable { .. }) => (
                FailureKind::PropertyWrite,
                "property_definitions_unreadable",
            ),
            Self::File(PropertiesFileError::Write { .. }) => {
                (FailureKind::Storage, "property_definitions_write_failed")
            }
            Self::Storage(error) => error.kind_and_code(),
            Self::Auth(error) => error.kind_and_code(),
        }
    }
}
