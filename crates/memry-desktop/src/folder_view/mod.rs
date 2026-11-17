//! Folder views and a tag's table (`ipc/folder-view-handlers.ts`): the rows, the property
//! columns, and the saved views of a scope. A folder keeps its views, formulas, column names
//! and summaries in its `.folder.md` ([`folder_file`]); a tag, which has no directory, keeps its
//! views on its synced `tag_definition` record. Which rows a scope lists is the core's
//! ([`memry_core::domain::folder_view`]); this module checks the input at the boundary and
//! edits the saved views.
//!
//! A view edit reads the scope's views and writes them whole. A folder's runs under the
//! settings file's own lock, which reads the file again; a tag's in one transaction of the data
//! database's writer, so two edits of one scope, or an edit and a sync apply, never lose each
//! other.

pub mod view;

use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::domain::folder_view::{self, RowSet, TagViews};
pub use memry_core::domain::tag_objects::Resolved;
use memry_core::domain::tags::tag_key;
use memry_core::seams::secure_store::SecureStore;
use serde_json::{Map, Value};

use crate::error::{CoreError, FailureKind};
use crate::notes::error::NotesError;
use crate::notes::folders::vault_folder;
use crate::session::OpenVault;
use crate::tags::{Hub, TagsError};
use crate::vault::folder_file::{self, FolderFileError};
use view::{
    AvailablePropertiesView, BuiltInColumnView, FormulaView, ListInput, ListView, SavedViewsView,
    ViewScope,
};

/// The most rows one call lists (`ListWithPropertiesRequestSchema.limit`).
pub const MAX_ROWS: u32 = 1000;
const DEFAULT_ROWS: u32 = 500;

#[derive(Debug, thiserror::Error)]
pub enum FolderViewError {
    #[error("{0}")]
    Invalid(String),
    /// `previousName` renames a view onto the name another one has.
    #[error("A view named \"{0}\" already exists")]
    Duplicate(String),
    #[error(transparent)]
    Notes(#[from] NotesError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Tags(#[from] TagsError),
}

impl From<FolderFileError> for FolderViewError {
    fn from(error: FolderFileError) -> Self {
        Self::Notes(error.into())
    }
}

impl CoreError for FolderViewError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Invalid(_) => (FailureKind::Invalid, "invalid"),
            Self::Duplicate(_) => (FailureKind::Invalid, "view_name_conflict"),
            Self::Notes(error) => error.kind_and_code(),
            Self::Storage(error) => error.kind_and_code(),
            Self::Tags(error) => error.kind_and_code(),
        }
    }
}

fn invalid(what: &str) -> FolderViewError {
    FolderViewError::Invalid(what.to_owned())
}

/// A tag scope's tag and AND tags, refused when one is empty (`ViewScopeSchema`: `min(1)`).
fn tag_scope<'a>(
    tag: &'a str,
    and_tags: &'a Option<Vec<String>>,
) -> Result<(&'a str, &'a [String]), FolderViewError> {
    let and_tags = and_tags.as_deref().unwrap_or_default();
    if tag.is_empty() || and_tags.iter().any(String::is_empty) {
        return Err(invalid("a tag scope needs a tag name"));
    }
    Ok((tag, and_tags))
}

/// Whether the scope is a tag's: its rows and columns read the resolved tags.
pub fn is_tag(scope: &ViewScope) -> bool {
    matches!(scope, ViewScope::Tag { .. })
}

/// `folder-view:list-with-properties`. `resolved` is read for a tag scope only.
pub fn list(
    open: &OpenVault,
    input: &ListInput,
    resolved: Option<&Resolved>,
) -> Result<ListView, FolderViewError> {
    let limit = input.limit.unwrap_or(DEFAULT_ROWS);
    if !(1..=MAX_ROWS).contains(&limit) {
        return Err(invalid("a page holds 1 to 1000 rows"));
    }
    let offset = input.offset.unwrap_or(0);
    match &input.scope {
        ViewScope::Folder { path } => {
            let folder = vault_folder(&open.path, path)?;
            let page = open.search.folder_rows(&folder, limit, offset)?;
            Ok(ListView {
                notes: page.rows.into_iter().map(Into::into).collect(),
                total: page.total,
                has_more: page.has_more,
                complete: None,
            })
        }
        ViewScope::Tag { tag, and_tags } => {
            let (tag, and_tags) = tag_scope(tag, and_tags)?;
            let set = input.rows.map_or(RowSet::Objects, Into::into);
            let fields = match resolved {
                Some(resolved) => open.search.field_tag_rows(resolved, tag, and_tags, set)?,
                None => None,
            };
            let (rows, complete) = match fields {
                Some(fields) => (fields.rows, Some(fields.complete)),
                None => (open.search.tag_rows(tag, and_tags)?, None),
            };
            let total = u32::try_from(rows.len()).unwrap_or(u32::MAX);
            let page: Vec<_> = rows
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .map(Into::into)
                .collect();
            let has_more = (offset as usize).saturating_add(page.len()) < total as usize;
            Ok(ListView {
                notes: page,
                total,
                has_more,
                complete,
            })
        }
    }
}

fn built_in(id: &str, display_name: &str, type_name: &str) -> BuiltInColumnView {
    BuiltInColumnView {
        id: id.to_owned(),
        display_name: display_name.to_owned(),
        type_name: type_name.to_owned(),
    }
}

/// `folder-view:get-available-properties`: the built-in columns (a tag's also `kind`, the only
/// scope that mixes row kinds), the properties the listed notes hold, most used first, and a
/// folder's formulas. A tag's fields are columns before any note holds them.
pub fn available_properties(
    open: &OpenVault,
    scope: &ViewScope,
    resolved: Option<&Resolved>,
) -> Result<AvailablePropertiesView, FolderViewError> {
    let mut built_in_columns = vec![
        built_in("title", "Title", "text"),
        built_in("folder", "Folder", "text"),
        built_in("tags", "Tags", "multiselect"),
        built_in("created", "Created", "date"),
        built_in("modified", "Modified", "date"),
        built_in("wordCount", "WordCount", "number"),
    ];
    let (properties, formulas) = match scope {
        ViewScope::Tag { tag, and_tags } => {
            let (tag, and_tags) = tag_scope(tag, and_tags)?;
            built_in_columns.push(built_in("kind", "Kind", "text"));
            let ids = open.search.tag_note_ids(tag, and_tags)?;
            let fields = resolved
                .map(|resolved| folder_view::field_columns(tag, resolved))
                .unwrap_or_default();
            (open.search.property_counts(&ids, &fields)?, Vec::new())
        }
        ViewScope::Folder { path } => {
            let folder = vault_folder(&open.path, path)?;
            let formulas = folder_file::read(&open.path, &folder)
                .inspect_err(|error| {
                    tracing::warn!(
                        scope = "folder_view",
                        "a folder's formulas are unread: {error}"
                    )
                })
                .ok()
                .flatten()
                .and_then(|file| file.config().formulas)
                .and_then(|formulas| match formulas {
                    Value::Object(map) => Some(map),
                    _ => None,
                })
                .unwrap_or_default()
                .into_iter()
                .map(|(id, expression)| FormulaView {
                    expression: match expression {
                        Value::String(text) => text,
                        other => other.to_string(),
                    },
                    id,
                })
                .collect();
            let ids = open.search.folder_note_ids(&folder)?;
            (open.search.property_counts(&ids, &[])?, formulas)
        }
    };
    Ok(AvailablePropertiesView {
        built_in: built_in_columns,
        properties: properties.into_iter().map(Into::into).collect(),
        formulas,
    })
}

/// A scope's saved views as stored: a folder's from its file (one that cannot be read has
/// none), a tag's from its definition (one that does not parse has none).
fn stored_views(open: &OpenVault, scope: &ViewScope) -> Result<Vec<Value>, FolderViewError> {
    match scope {
        ViewScope::Folder { path } => {
            let folder = vault_folder(&open.path, path)?;
            Ok(folder_file::read(&open.path, &folder)
                .inspect_err(|error| {
                    tracing::warn!(
                        scope = "folder_view",
                        "a folder's views are unread: {error}"
                    )
                })
                .ok()
                .flatten()
                .map(|file| file.view_list())
                .unwrap_or_default())
        }
        ViewScope::Tag { tag, and_tags } => {
            let (tag, _) = tag_scope(tag, and_tags)?;
            let tag = tag.to_owned();
            let views = open
                .vault
                .db_handle()
                .read_blocking(move |data| folder_view::tag_views(data, &tag))?;
            if views == TagViews::Unparsed {
                tracing::warn!(
                    scope = "folder_view",
                    "a tag's saved views do not parse; read as none"
                );
            }
            Ok(views.list())
        }
    }
}

/// `folder-view:get-views`: the saved views and the one shown first, the first marked
/// `default` (else the first). An entry that is not an object with a name is no view and is
/// left out before the default is counted.
pub fn views(
    open: &OpenVault,
    scope: &ViewScope,
    resolved: Option<&Resolved>,
) -> Result<SavedViewsView, FolderViewError> {
    let views: Vec<Value> = stored_views(open, scope)?
        .into_iter()
        .filter(|view| name_of(view).is_some())
        .collect();
    if views.is_empty() {
        let field_columns = match (scope, resolved) {
            (ViewScope::Tag { tag, .. }, Some(resolved)) => resolved
                .get(&tag_key(tag))
                .filter(|entry| entry.has_fields)
                .map(|entry| {
                    entry
                        .effective_fields
                        .iter()
                        .map(|f| f.name.clone())
                        .collect()
                }),
            _ => None,
        };
        return Ok(SavedViewsView {
            views: None,
            default_index: 0,
            field_columns,
        });
    }
    let default_index = views
        .iter()
        .position(is_default)
        .and_then(|at| u32::try_from(at).ok())
        .unwrap_or(0);
    Ok(SavedViewsView {
        views: Some(views),
        default_index,
        field_columns: None,
    })
}

fn is_default(view: &Value) -> bool {
    view.get("default") == Some(&Value::Bool(true))
}

fn name_of(view: &Value) -> Option<&str> {
    view.get("name").and_then(Value::as_str)
}

/// `folder-view:set-view`'s rule: a view replaces the one of its name (a rename the one named
/// `previous`, keeping its place) or is added last; a view marked `default` clears the mark on
/// the others. A rename onto another view's name is refused.
pub fn with_view(
    mut views: Vec<Value>,
    view: Value,
    previous: Option<&str>,
) -> Result<Vec<Value>, FolderViewError> {
    let name = name_of(&view)
        .ok_or_else(|| invalid("a view needs a name"))?
        .to_owned();
    let renamed = previous.filter(|previous| *previous != name);
    if renamed.is_some() && views.iter().any(|v| name_of(v) == Some(&name)) {
        return Err(FolderViewError::Duplicate(name));
    }
    let at = renamed
        .and_then(|previous| views.iter().position(|v| name_of(v) == Some(previous)))
        .or_else(|| views.iter().position(|v| name_of(v) == Some(&name)));
    let default = is_default(&view);
    let at = match at {
        Some(at) => {
            views[at] = view;
            at
        }
        None => {
            views.push(view);
            views.len() - 1
        }
    };
    if default {
        for (i, other) in views.iter_mut().enumerate() {
            if i != at
                && let Some(map) = other.as_object_mut()
            {
                map.insert("default".to_owned(), Value::Bool(false));
            }
        }
    }
    Ok(views)
}

/// `folder-view:delete-view`'s rule: the view named `name` goes; when none left is marked
/// `default`, the first is.
pub fn without_view(views: Vec<Value>, name: &str) -> Vec<Value> {
    let mut kept: Vec<Value> = views
        .into_iter()
        .filter(|view| name_of(view) != Some(name))
        .collect();
    if !kept.iter().any(is_default)
        && let Some(map) = kept.first_mut().and_then(Value::as_object_mut)
    {
        map.insert("default".to_owned(), Value::Bool(true));
    }
    kept
}

/// Reads the scope's views, lets `change` edit them and writes them whole. A tag's are written
/// through its hub under `store`'s device identity, which makes its definition when it has none.
pub fn edit_views(
    open: &OpenVault,
    scope: &ViewScope,
    store: Arc<dyn SecureStore>,
    change: impl FnOnce(Vec<Value>) -> Result<Vec<Value>, FolderViewError>,
) -> Result<(), FolderViewError> {
    match scope {
        ViewScope::Folder { path } => {
            let folder = vault_folder(&open.path, path)?;
            folder_file::try_update(&open.path, &folder, |file| {
                let views = change(file.view_list())?;
                file.set_views(&views);
                Ok::<_, FolderViewError>(())
            })?;
            Ok(())
        }
        ViewScope::Tag { tag, and_tags } => {
            let (tag, _) = tag_scope(tag, and_tags)?;
            Hub::open(open, store)?.edit_views(&tag_key(tag), change)?
        }
    }
}

/// `folder-view:set-config`: the modelled keys `config` names, `null` removing one; the views
/// of the folder are among them.
pub fn set_config(
    open: &OpenVault,
    folder: &str,
    config: &Map<String, Value>,
) -> Result<(), FolderViewError> {
    let folder = vault_folder(&open.path, folder)?;
    folder_file::try_update(&open.path, &folder, |file| {
        file.merge(config).map_err(FolderViewError::Invalid)
    })?;
    Ok(())
}

/// `folder-view:folder-exists`: a directory at that vault path (`""`: the vault root).
pub fn folder_exists(open: &OpenVault, folder: &str) -> bool {
    match vault_folder(&open.path, folder) {
        Ok(folder) => folder
            .split('/')
            .filter(|segment| !segment.is_empty())
            .fold(open.path.clone(), |path, segment| path.join(segment))
            .is_dir(),
        Err(_) => false,
    }
}
