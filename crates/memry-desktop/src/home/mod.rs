//! Home boards as the renderer sees them (`home-page-api.ts`, Electron
//! `ipc/home-page-handlers.ts`). The rules are the core's
//! ([`memry_core::domain::home_page`]): the record, the clock, reorder, the
//! cover framing and the legacy widget read. This module checks the input at
//! the boundary, shapes the answers and owns the cover files ([`covers`]).

pub mod covers;

use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::api::home_pages::{BoardChanges, HomePages};
use memry_core::domain::home_page::cover::FramingChanges;
use memry_core::domain::home_page::{HomePage, widgets};
use memry_core::seams::secure_store::SecureStore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::session::OpenVault;
use crate::vault::covers::delete_cover_dir;

const SCOPE: &str = "HomePages";

/// `WidgetInstance` as the grid reads it. A widget of a type this build does
/// not know comes through like any other.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct WidgetView {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub config: Map<String, Value>,
}

/// `HomePageCoverSync`: the fields the band reads. The record keeps every
/// other key a newer build wrote.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HomePageCoverView {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub focus: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub focus_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub zoom: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub credit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub credit_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub attachment_id: Option<String>,
}

/// `HomePage`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct HomePageView {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub icon: Option<String>,
    pub position: f64,
    pub widgets: Vec<WidgetView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub cover: Option<HomePageCoverView>,
}

impl From<HomePage> for HomePageView {
    fn from(row: HomePage) -> Self {
        let widgets = widgets::display(&row.widgets).unwrap_or_else(|| {
            tracing::warn!(
                scope = SCOPE,
                board_id = row.id,
                "a home board has an unparseable widgets blob, rendering it empty"
            );
            Vec::new()
        });
        let cover = row.cover.as_deref().and_then(|text| {
            serde_json::from_str(text)
                .inspect_err(|error| {
                    tracing::warn!(
                        scope = SCOPE,
                        board_id = row.id,
                        "a board cover was not read: {error}"
                    );
                })
                .ok()
        });
        Self {
            widgets: widgets
                .into_iter()
                .map(|widget| WidgetView {
                    id: widget.id,
                    kind: widget.kind,
                    x: widget.x,
                    y: widget.y,
                    w: widget.w,
                    h: widget.h,
                    config: widget.config,
                })
                .collect(),
            id: row.id,
            name: row.name,
            icon: row.icon,
            position: row.position,
            cover,
        }
    }
}

/// `WidgetInstanceSchema`. Written back in its key order, which is the order
/// `JSON.stringify` gives the parsed object in Electron.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct WidgetInput {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub config: Map<String, Value>,
}

/// `HomePageCreateSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct HomePageCreateInput {
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub position: Option<u32>,
    #[serde(default)]
    pub widgets: Option<Vec<WidgetInput>>,
}

/// `HomePageUpdateSchema`: an absent field stays as it is.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct HomePageUpdateInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub position: Option<u32>,
    #[serde(default)]
    pub widgets: Option<Vec<WidgetInput>>,
}

/// `HomePageSetCoverFramingSchema.changes`: only the fields that changed.
#[derive(Debug, Clone, Copy, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverFramingInput {
    #[serde(default)]
    pub focus_x: Option<f64>,
    #[serde(default)]
    pub focus_y: Option<f64>,
    #[serde(default)]
    pub zoom: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
}

fn invalid(what: impl Into<String>) -> StorageError {
    StorageError::Invalid { what: what.into() }
}

fn in_range(value: Option<f64>, low: f64, high: f64, what: &str) -> Result<(), StorageError> {
    match value {
        Some(value) if !(low..=high).contains(&value) => {
            Err(invalid(format!("a cover's {what} is from {low} to {high}")))
        }
        _ => Ok(()),
    }
}

impl CoverFramingInput {
    fn checked(self) -> Result<FramingChanges, StorageError> {
        in_range(self.focus_x, 0.0, 100.0, "focusX")?;
        in_range(self.focus_y, 0.0, 100.0, "focusY")?;
        in_range(self.zoom, 1.0, 3.0, "zoom")?;
        in_range(self.height, 120.0, 480.0, "height")?;
        Ok(FramingChanges {
            focus_x: self.focus_x,
            focus_y: self.focus_y,
            zoom: self.zoom,
            height: self.height,
        })
    }
}

/// The widgets as the record's JSON array text, after `WidgetInstanceSchema`'s
/// checks.
fn widgets_text(widgets: &[WidgetInput]) -> Result<String, StorageError> {
    if let Some(bad) = widgets.iter().find(|widget| {
        widget.id.is_empty() || widget.kind.is_empty() || widget.w < 1 || widget.h < 1
    }) {
        return Err(invalid(format!(
            "widget {:?} needs an id, a type and a size of at least 1x1",
            bad.id
        )));
    }
    serde_json::to_string(widgets).map_err(|error| invalid(error.to_string()))
}

fn view(row: HomePage) -> HomePageView {
    row.into()
}

/// The open vault's boards, written under this device's identity.
pub struct HomeBoards {
    boards: HomePages,
    vault: PathBuf,
}

impl HomeBoards {
    /// Writes under the device identity in `store` (minted on the first synced write of a
    /// profile; sign-in reuses it).
    pub fn open(open: &OpenVault, store: Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        ensure_device_identity(store.clone())?;
        Ok(Self::new(open.path.clone(), open.vault.home_pages(store)?))
    }

    /// The boards of the vault at `vault`.
    pub fn new(vault: PathBuf, boards: HomePages) -> Self {
        Self { boards, vault }
    }

    /// `home-pages:list`.
    pub fn list(&self) -> Result<Vec<HomePageView>, StorageError> {
        Ok(self.boards.list()?.into_iter().map(view).collect())
    }

    /// `home-pages:get`.
    pub fn get(&self, id: String) -> Result<Option<HomePageView>, StorageError> {
        Ok(self.boards.get(id)?.map(view))
    }

    /// `home-pages:create`.
    pub fn create(&self, input: HomePageCreateInput) -> Result<HomePageView, StorageError> {
        let widgets = widgets_text(input.widgets.as_deref().unwrap_or_default())?;
        let position = f64::from(input.position.unwrap_or(0));
        self.boards
            .create(input.name, input.icon, position, widgets)
            .map(view)
    }

    /// `home-pages:update`.
    pub fn update(&self, input: HomePageUpdateInput) -> Result<HomePageView, StorageError> {
        let widgets = input.widgets.as_deref().map(widgets_text).transpose()?;
        let changes = BoardChanges {
            name: input.name,
            icon: input.icon,
            position: input.position.map(f64::from),
            widgets,
            cover: None,
        };
        self.boards.update(input.id, changes).map(view)
    }

    /// `home-pages:delete`: `false` when there was no such board. A deleted
    /// board's cover folder goes with it.
    pub fn delete(&self, id: String) -> Result<bool, StorageError> {
        let deleted = self.boards.delete(id.clone())?;
        if deleted {
            delete_cover_dir(&self.vault, &id);
        }
        Ok(deleted)
    }

    /// `home-pages:reorder`: the ids of the boards that moved.
    pub fn reorder(&self, ids: Vec<String>) -> Result<Vec<String>, StorageError> {
        if ids.iter().any(String::is_empty) {
            return Err(invalid("a board id is not empty"));
        }
        self.boards.reorder(ids)
    }

    /// `home-pages:set-cover-framing`.
    pub fn set_cover_framing(
        &self,
        id: String,
        changes: CoverFramingInput,
    ) -> Result<HomePageView, StorageError> {
        self.boards
            .set_cover_framing(id, changes.checked()?)
            .map(view)
    }
}
