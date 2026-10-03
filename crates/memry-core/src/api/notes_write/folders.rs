//! [`NotesWriter`]'s reminder (N804) and folder (N806) writes.
//!
//! A second `#[uniffi::export]` block on the same object; a child module so it
//! shares the writer's private device id and id minting.

use super::{NotesWriter, now_ms};
use crate::api::errors::StorageError;
use crate::domain::{folders, reminders};

#[uniffi::export]
impl NotesWriter {
    // MARK: - Reminders (N804)

    /// Sets a reminder on a note and returns its id.
    ///
    /// `remind_at` is an ISO **instant**, unlike a date mention's calendar
    /// day: a reminder fires at a moment, and the moment is the same
    /// everywhere.
    pub fn add_reminder(
        &self,
        note_id: String,
        remind_at: String,
        title: Option<String>,
    ) -> Result<String, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let id = Self::new_id();
            reminders::create(
                conn,
                &id,
                &note_id,
                &remind_at,
                title.as_deref(),
                &device_id,
                now_ms(),
            )?;
            Ok(id)
        })
    }

    /// Dismisses a reminder. A status change, never a delete: a dismissal has
    /// to reach the other devices, and a row that vanished has nothing left
    /// to send.
    pub fn dismiss_reminder(&self, id: String) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::dismiss(conn, &id, &device_id, now_ms())?;
            Ok(())
        })
    }

    pub fn snooze_reminder(&self, id: String, until: String) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            reminders::snooze(conn, &id, &until, &device_id, now_ms())?;
            Ok(())
        })
    }

    // MARK: - Folders (N806)

    /// Creates a `folder_config` at `path`.
    ///
    /// The whole folder domain existed and nothing could reach it, which is
    /// what N806 records: the core could create, rename, move and delete a
    /// folder, and no API method said so.
    pub fn create_folder(&self, path: String, icon: Option<String>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            folders::create(conn, &path, icon.as_deref(), &device_id, now_ms())?;
            Ok(())
        })
    }

    /// Sets or clears a folder's icon. `nil` writes an explicit null.
    ///
    /// A folder that only exists because notes are in it gets its
    /// `folder_config` created with the icon, as desktop does.
    pub fn set_folder_icon(&self, path: String, icon: Option<String>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            folders::set_icon(conn, &path, icon.as_deref(), &device_id, now_ms())?;
            Ok(())
        })
    }

    /// Renames a folder in place, keeping its parent.
    ///
    /// - Returns: the ids of the notes whose `folderPath` was rewritten, so a
    ///   shell can refresh exactly those rather than reloading the vault.
    pub fn rename_folder(
        &self,
        path: String,
        new_name: String,
    ) -> Result<Vec<String>, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            Ok(folders::rename(conn, &path, &new_name, &device_id, now_ms())?.notes)
        })
    }

    /// Moves a folder under `new_parent`, or to the vault root with `nil`.
    pub fn move_folder(
        &self,
        path: String,
        new_parent: Option<String>,
    ) -> Result<Vec<String>, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            Ok(folders::move_to(conn, &path, new_parent.as_deref(), &device_id, now_ms())?.notes)
        })
    }

    /// Tombstones a folder and every `folder_config` under it.
    ///
    /// **Throws when the subtree still holds a live note**, rather than
    /// cascading. No chapter defines a cascading folder delete and a note
    /// tombstone travels to every device in the vault: refusing costs a step
    /// in the shell's flow, guessing costs the user their notes.
    ///
    /// - Returns: the paths that were tombstoned.
    pub fn delete_folder(&self, path: String) -> Result<Vec<String>, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            Ok(folders::delete(conn, &path, &device_id, now_ms())?.folders)
        })
    }
}
