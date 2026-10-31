//! The converter the consumer, the write-back and the note identity read and write note bodies
//! with: the vault's callout types, read from its app settings.

use memry_core::api::errors::StorageError;
use memry_core::domain::app_settings::AppSettings;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::{
    CalloutTypes, sanitize_callout_type_definitions,
};

const SCOPE: &str = "vault_consumer";

/// The converter with the vault's callout types. Read for every write, so a callout type added
/// in the app is known to the next feed and write-back.
pub(crate) fn converter_for(settings: Option<&AppSettings>) -> Converter {
    settings
        .map(converter_of)
        .and_then(|converter| {
            converter
                .inspect_err(|error| {
                    tracing::warn!(scope = SCOPE, "callout types could not be read: {error}");
                })
                .ok()
        })
        .unwrap_or_else(|| Converter::new(CalloutTypes::new(Vec::new())))
}

/// [`converter_for`] that fails when the callout types cannot be read, for a caller that
/// compares a body's markdown with a file's, where a callout written out without its type
/// would differ.
pub(crate) fn converter_of(settings: &AppSettings) -> Result<Converter, StorageError> {
    let definitions = settings
        .get_path("editor.calloutTypes")?
        .map(|value| sanitize_callout_type_definitions(&value))
        .unwrap_or_default();
    Ok(Converter::new(CalloutTypes::new(definitions)))
}
