//! A board's banner (`home/cover-service.ts`): a wash, or an image the board
//! owns at `.memry/home-covers/<boardId>/<file>`. Every image source the picker
//! offers is copied there and the board saved in the same call, so a board
//! never depends on a note's attachment. The file layer is
//! [`crate::vault::covers`].
//!
//! One process-wide lock covers each step that writes a cover file, saves the
//! row and prunes, and each reconcile. Electron's `settingCover` set guards
//! the same window: a reconcile between the file write and the row write would
//! prune a file the row does not name yet.
//!
//! The bytes of an image cover stay on this device until Step 30f
//! (`attachmentId`, upload and download); [`HomeBoards::reconcile`] only
//! prunes.

use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::sync::Mutex;

use memry_core::api::errors::StorageError;
use memry_core::api::home_pages::BoardChanges;
use memry_core::domain::home_page::cover::wash_ref;
use serde::Serialize;
use serde_json::{Map, Value};

use super::{HomeBoards, HomePageView, SCOPE};
use crate::attachments::{
    MAX_FILE_SIZE, RemoteFailure, extension, is_allowed_extension, random_prefix, stored_name,
};
use crate::notes::unsplash::UnsplashFailure;
use crate::shell::file_open::is_plain_segment;
use crate::vault::covers::{cover_file_path, prune_cover_files, write_cover};
use crate::vault::layout::ATTACHMENTS_DIR;

static COVER_LOCK: Mutex<()> = Mutex::new(());

fn cover_lock() -> std::sync::MutexGuard<'static, ()> {
    COVER_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `HomePageCoverFailure`: why a picked cover was not set. Each picker tab
/// shows the ones it knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum CoverFailure {
    NotConfigured,
    Offline,
    RateLimited,
    Failed,
    WriteFailed,
    NotAnImage,
    TooLarge,
}

impl From<RemoteFailure> for CoverFailure {
    fn from(failure: RemoteFailure) -> Self {
        match failure {
            RemoteFailure::NotAnImage => Self::NotAnImage,
            RemoteFailure::TooLarge => Self::TooLarge,
            RemoteFailure::Offline => Self::Offline,
            RemoteFailure::Failed => Self::Failed,
            RemoteFailure::WriteFailed => Self::WriteFailed,
        }
    }
}

impl From<UnsplashFailure> for CoverFailure {
    fn from(failure: UnsplashFailure) -> Self {
        match failure {
            UnsplashFailure::NotConfigured => Self::NotConfigured,
            UnsplashFailure::Offline => Self::Offline,
            UnsplashFailure::RateLimited => Self::RateLimited,
            UnsplashFailure::Failed => Self::Failed,
        }
    }
}

/// What a set-cover call came to: `HomePageSetCoverResult`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SetCoverOutcome {
    Saved { page: Box<HomePageView> },
    Failed { reason: CoverFailure },
}

/// An image picked as a cover, before it is the board's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverImage {
    pub filename: String,
    pub bytes: Vec<u8>,
    /// The Unsplash credit, name and profile URL.
    pub credit: Option<(String, String)>,
}

/// How a board's cover folder is pruned: by its ref, which is remote input.
enum Keep<'a> {
    /// A wash, a link or no cover: no file of the folder is the cover's.
    Nothing,
    /// The cover's own file.
    File(&'a Path),
}

/// What the stored cover keeps. `None` for a ref that names a vault file this
/// build refuses (a name that is not one plain segment, or another folder):
/// such a board is not pruned at all, since an Electron device may still show
/// the file (`generateUniqueFilename` kept a trailing `.` that
/// [`is_plain_segment`] refuses).
fn keep_for<'a>(reference: Option<&str>, file: Option<&'a Path>) -> Option<Keep<'a>> {
    match (reference, file) {
        (_, Some(file)) => Some(Keep::File(file)),
        (None, None) => Some(Keep::Nothing),
        (Some(reference), None) => {
            let lower = reference.to_ascii_lowercase();
            let remote = lower.starts_with("http://") || lower.starts_with("https://");
            (reference.starts_with("wash:") || remote).then_some(Keep::Nothing)
        }
    }
}

fn prune(vault: &Path, board_id: &str, keep: Keep<'_>) {
    match keep {
        Keep::Nothing => prune_cover_files(vault, board_id, None),
        Keep::File(file) => prune_cover_files(vault, board_id, Some(file)),
    }
}

fn saved(page: HomePageView) -> SetCoverOutcome {
    SetCoverOutcome::Saved {
        page: Box::new(page),
    }
}

impl HomeBoards {
    fn save_cover(
        &self,
        board_id: &str,
        cover: Option<Value>,
    ) -> Result<HomePageView, StorageError> {
        let changes = BoardChanges {
            cover: Some(cover),
            ..BoardChanges::default()
        };
        self.boards
            .update(board_id.to_owned(), changes)
            .map(Into::into)
    }

    /// `NotFound` when no live board has the id, checked before a cover's
    /// bytes are fetched.
    pub fn require(&self, board_id: &str) -> Result<(), StorageError> {
        match self.boards.get(board_id.to_owned())? {
            Some(_) => Ok(()),
            None => Err(StorageError::NotFound {
                what: format!("no home board {board_id}"),
            }),
        }
    }

    /// The `wash` source: the board's banner becomes a colour wash and its
    /// cover files go.
    pub fn set_wash(&self, board_id: &str, wash_id: &str) -> Result<SetCoverOutcome, StorageError> {
        self.require(board_id)?;
        let Some(reference) = wash_ref(wash_id) else {
            return Ok(SetCoverOutcome::Failed {
                reason: CoverFailure::Failed,
            });
        };
        let _guard = cover_lock();
        let page = self.save_cover(board_id, Some(serde_json::json!({ "ref": reference })))?;
        prune(&self.vault, board_id, Keep::Nothing);
        Ok(saved(page))
    }

    /// Every image source: the bytes become the board's cover file and the
    /// board names it. A type the vault does not take, a file over the
    /// attachment cap or a failed write sets nothing.
    pub fn set_image(
        &self,
        board_id: &str,
        image: CoverImage,
    ) -> Result<SetCoverOutcome, StorageError> {
        let failed = |reason| Ok(SetCoverOutcome::Failed { reason });
        if !is_allowed_extension(extension(&image.filename)) {
            return failed(CoverFailure::NotAnImage);
        }
        if image.bytes.len() > MAX_FILE_SIZE {
            return failed(CoverFailure::TooLarge);
        }
        self.require(board_id)?;
        let name = stored_name(&random_prefix(), &image.filename);
        let _guard = cover_lock();
        let reference = match write_cover(&self.vault, board_id, &name, &image.bytes) {
            Ok(reference) => reference,
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    board_id,
                    "a board cover was not written: {error}"
                );
                return failed(CoverFailure::WriteFailed);
            }
        };
        let file = cover_file_path(&self.vault, board_id, &reference);
        let mut cover = Map::new();
        cover.insert("ref".to_owned(), Value::from(reference));
        if let Some((name, url)) = image.credit {
            cover.insert("credit".to_owned(), Value::from(name));
            cover.insert("creditUrl".to_owned(), Value::from(url));
        }
        let page = match self.save_cover(board_id, Some(Value::Object(cover))) {
            Ok(page) => page,
            Err(error) => {
                // The board went while the file was written: leave no file behind.
                if let Some(file) = &file {
                    let _ = fs::remove_file(file).inspect_err(|remove| {
                        tracing::warn!(
                            scope = SCOPE,
                            board_id,
                            "an unused cover file stayed: {remove}"
                        );
                    });
                }
                return Err(error);
            }
        };
        if let Some(file) = &file {
            prune(&self.vault, board_id, Keep::File(file));
        }
        Ok(saved(page))
    }

    /// `home-pages:remove-cover`: no banner, no cover files.
    pub fn remove_cover(&self, board_id: &str) -> Result<HomePageView, StorageError> {
        let _guard = cover_lock();
        let page = self.save_cover(board_id, None)?;
        prune(&self.vault, board_id, Keep::Nothing);
        Ok(page)
    }

    /// The `vaultFile` source: an image already in a note's attachments
    /// folder, `attachments/<ownerNoteId>/<filename>`.
    pub fn read_vault_image(
        &self,
        owner_note_id: &str,
        filename: &str,
    ) -> Result<CoverImage, CoverFailure> {
        if !is_plain_segment(owner_note_id) || !is_plain_segment(filename) {
            return Err(CoverFailure::Failed);
        }
        let file = self
            .vault
            .join(ATTACHMENTS_DIR)
            .join(owner_note_id)
            .join(filename);
        let bytes = read_capped(&file).map_err(|error| {
            tracing::error!(
                scope = SCOPE,
                "the vault image picked as a board cover was not read: {error}"
            );
            CoverFailure::Failed
        })?;
        let bytes = bytes.ok_or(CoverFailure::TooLarge)?;
        Ok(CoverImage {
            filename: filename.to_owned(),
            bytes,
            credit: None,
        })
    }

    /// `reconcileHomeCovers` without the byte sync of Step 30f: deletes the
    /// files a board's cover no longer names (a cover replaced or removed on
    /// another device), for one board or every board.
    pub fn reconcile(&self, board_id: Option<&str>) -> Result<(), StorageError> {
        let _guard = cover_lock();
        let boards = match board_id {
            Some(id) => self.boards.get(id.to_owned())?.into_iter().collect(),
            None => self.boards.list()?,
        };
        for board in boards {
            let cover: Option<Value> = board
                .cover
                .as_deref()
                .and_then(|text| serde_json::from_str(text).ok());
            let reference = cover
                .as_ref()
                .and_then(|cover| cover.get("ref"))
                .and_then(Value::as_str);
            let file =
                reference.and_then(|reference| cover_file_path(&self.vault, &board.id, reference));
            match keep_for(reference, file.as_deref()) {
                Some(keep) => prune(&self.vault, &board.id, keep),
                None => tracing::warn!(
                    scope = SCOPE,
                    board_id = board.id,
                    "a board cover names a file this build refuses; its folder is left as it is"
                ),
            }
        }
        Ok(())
    }
}

/// The file's bytes, or `None` when it is over the attachment cap: refused
/// before reading on its size, and again if it grew past the cap while read.
fn read_capped(file: &Path) -> io::Result<Option<Vec<u8>>> {
    let handle = fs::File::open(file)?;
    if handle.metadata()?.len() > MAX_FILE_SIZE as u64 {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    handle
        .take(MAX_FILE_SIZE as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok((bytes.len() <= MAX_FILE_SIZE).then_some(bytes))
}
