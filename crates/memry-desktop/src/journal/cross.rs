//! A held journal day renamed outside the app away from its day, turned into a note by the user
//! (Step 14l-3c, #3531; #4074 finding 3).
//!
//! A day the whole journal folder carried is held, never crossed (`notes::owed_moves::held`).
//! Renamed then to a name that is not its day (`Diary/2025-01-02.md` to `Diary/Trip.md`), no
//! follow of the journal folder makes it the day again, so it would wait for good. Electron
//! crosses such a file at the rename (`renameKeepsJournalDate`, `vault/watcher.ts`): the journal
//! entry is deleted, the delete synced, and the file listed as a new note with a fresh id. Here
//! the vault's notices list the day (`VaultNotice::JournalDaysRenamed`) and the user turns it
//! into a note, which makes that same crossing: in the day's write order, with the settings'
//! update lock and then the rows' lane held, the record is deleted as a move between note and
//! day deletes it (`NotesWriter::file_crossed`, which keeps a day that has text its file does
//! not), the row goes, and the watcher looks at the file again, which the consumer makes a new
//! note. The file itself is never touched.
//!
//! Refused while a journal setting change is recorded (it owns the days until it settles), for a
//! locked or excluded day, and while a write of the day waits for its turn: an editor save sent
//! before the click that landed after the delete would make the day again, its sync delete
//! undone, so the day stays one and the user asks again. A day that is no longer held and
//! renamed away is left as it is.

use super::write::order_key;
use crate::locks::Locks;
use crate::notes::error::{NotesError, SCOPE};
use crate::notes::moves::identity_failed;
use crate::notes::service::NotesService;
use crate::session::OpenVault;
use crate::vault::config::settings::JournalFollow;
use crate::vault::consumer::identity::IdentityCtx;
use crate::vault::consumer::{Applied, ChangeSource};

impl NotesService {
    /// Turns each held day of `note_ids` renamed away from its day into a note (the module's
    /// doc). Answers the dates of the days it crossed; one it did not cross is logged and stays
    /// a day, listed on the vault's notices while it is still such a day.
    pub fn cross_renamed_days(
        &self,
        open: &OpenVault,
        note_ids: &[String],
    ) -> Result<Vec<String>, NotesError> {
        self.cross_renamed_days_checked(open, note_ids, &mut || {})
    }

    /// [`Self::cross_renamed_days`] with a hook that runs in each day's turn before the day's
    /// writes waiting are counted, so a test can queue a save behind the cross.
    #[doc(hidden)]
    pub fn cross_renamed_days_checked(
        &self,
        open: &OpenVault,
        note_ids: &[String],
        in_turn: &mut dyn FnMut(),
    ) -> Result<Vec<String>, NotesError> {
        let writer = open.vault.notes_writer(self.store.clone())?;
        let mut crossed = Vec::new();
        for note_id in note_ids {
            let Some(date) = writer.journal_date(note_id)? else {
                tracing::warn!(scope = SCOPE, note_id, "a renamed day to cross is no day");
                continue;
            };
            match self.order.run(&order_key(&date), |_| {
                self.cross_now(open, note_id, &date, in_turn)
            }) {
                Ok(true) => crossed.push(date),
                Ok(false) => tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "a renamed held day stays a day: it is no longer one, or the day has text its \
                     file does not"
                ),
                Err(error) => tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "a renamed held day was not turned into a note: {error}"
                ),
            }
        }
        Ok(crossed)
    }

    /// How many writes of the day `date` hold or wait for its turn, for a test.
    #[doc(hidden)]
    pub fn day_writes(&self, date: &str) -> usize {
        self.order.writes(&order_key(date))
    }

    fn cross_now(
        &self,
        open: &OpenVault,
        note_id: &str,
        date: &str,
        in_turn: &mut dyn FnMut(),
    ) -> Result<bool, NotesError> {
        let root = open.path.as_path();
        // Before the lane (`settings`'s lock order): no journal setting change or folder follow
        // moves the days meanwhile.
        let _settings = JournalFollow::hold();
        let writer = open.vault.notes_writer(self.store.clone())?;
        if writer.pending_journal_change()?.is_some() {
            return Err(NotesError::JournalChangeWaits);
        }
        let rows = self.tier.rows();
        let session = rows.session_for(&open.vault)?;
        let identity = self.tier.identity();
        let mut lane = rows.lane_of(session)?;
        let Some(row) = lane.files().by_id(note_id)? else {
            return Ok(false);
        };
        Locks::of(open).refuse_note(note_id, &row.path)?;
        in_turn();
        if self.order.writes(&order_key(date)) > 1 {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "a renamed held day stays a day: a write of it waits"
            );
            return Ok(false);
        }
        let ctx = IdentityCtx {
            root,
            vault: &open.vault,
            search: &open.search,
        };
        if !identity
            .cross_renamed_day(&ctx, note_id, &row.path)
            .map_err(identity_failed)?
        {
            return Ok(false);
        }
        // A row that does not go keeps the deleted record's debt, and the next open makes the
        // file anew, as for the consumer's crossing.
        lane.remove(note_id)?;
        lane.publish(Applied::Removed {
            note_id: note_id.to_owned(),
            path: row.path.clone(),
            source: ChangeSource::App,
        });
        drop(lane);
        self.tier.look_again(session, &row.path);
        Ok(true)
    }
}
