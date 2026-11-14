//! The desktop tag hub's accessors on [`Vault`] (desktop Step 13j). None is part of the FFI
//! surface: the Rust desktop shell is their only caller.

use std::sync::Arc;

use crate::api::errors::{AuthError, StorageError};
use crate::api::vault::Vault;
use crate::seams::secure_store::SecureStore;

impl Vault {
    /// The desktop tag hub's edits, written under this device's identity (desktop Step 13j).
    /// Not part of the FFI surface: the Rust desktop shell is its only caller.
    #[doc(hidden)]
    pub fn tag_hub(
        &self,
        store: Arc<dyn SecureStore>,
    ) -> Result<crate::api::tag_hub::TagHub, AuthError> {
        crate::api::tag_hub::TagHub::over(self.db.clone(), &store)
    }

    /// The desktop's tag schema edits, written under this device's identity (desktop Step 13j).
    /// Not part of the FFI surface: the Rust desktop shell is its only caller.
    #[doc(hidden)]
    pub fn tag_schemas(
        &self,
        store: Arc<dyn SecureStore>,
    ) -> Result<crate::api::tag_schemas::TagSchemas, AuthError> {
        crate::api::tag_schemas::TagSchemas::over(self.db.clone(), &store)
    }

    /// Every live tag definition with its stored schema ([`crate::domain::tag_schema::definitions`],
    /// desktop Step 13j); a read, so no identity. Not part of the FFI surface.
    #[doc(hidden)]
    pub fn tag_schema_definitions(
        &self,
    ) -> Result<
        std::collections::BTreeMap<String, crate::domain::tag_schema::DefinitionInput>,
        StorageError,
    > {
        self.db
            .read_blocking(crate::domain::tag_schema::definitions)
    }

    /// Whether this device dismissed the tag hub's ready-made tags
    /// ([`crate::domain::tag_schema::preset_offer_dismissed`]); a read. Not part of the FFI surface.
    #[doc(hidden)]
    pub fn tag_preset_offer_dismissed(&self) -> Result<bool, StorageError> {
        self.db
            .read_blocking(crate::domain::tag_schema::preset_offer_dismissed)
    }

    /// The field rename in progress ([`crate::domain::tag_schema::rename::recorded`], desktop
    /// Step 13j); a read, so no identity. Not part of the FFI surface.
    #[doc(hidden)]
    pub fn field_rename_recorded(
        &self,
    ) -> Result<Option<crate::domain::tag_schema::rename::RecordedRename>, StorageError> {
        self.db
            .read_blocking(crate::domain::tag_schema::rename::recorded)
    }

    /// The tag rename in progress ([`crate::domain::tag_rename::read`], desktop Step 13j); a
    /// read, so no identity. Not part of the FFI surface: the Rust desktop shell is its only
    /// caller.
    #[doc(hidden)]
    pub fn tag_rename_recorded(
        &self,
    ) -> Result<Option<crate::domain::tag_rename::Recorded>, StorageError> {
        self.db.read_blocking(crate::domain::tag_rename::read)
    }

    /// The tag hub's categories with their tag counts (desktop Step 13j); a read, so no
    /// identity. Not part of the FFI surface: the Rust desktop shell is its only caller.
    #[doc(hidden)]
    pub fn tag_categories(
        &self,
    ) -> Result<Vec<crate::domain::tag_categories::TagCategory>, StorageError> {
        self.db.read_blocking(crate::domain::tag_categories::list)
    }

    /// [`crate::domain::tag_fields::with_fields`], for desktop's header tag edit (Step 13f). Not
    /// part of the FFI surface.
    #[doc(hidden)]
    pub fn tags_with_fields(&self) -> Result<std::collections::HashSet<String>, StorageError> {
        self.db
            .read_blocking(crate::domain::tag_fields::with_fields)
    }
}
