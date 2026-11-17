//! The agent's conversation and message store (Step 28, #3545), the port of Electron's
//! `apps/desktop/src/main/agent/storage/` and `agent/sync/`. Records are the core's
//! `agent_conversation` and `agent_message` (Step 16, #3533), sealed at rest under the vault key.
//!
//! [`AgentStore::open`] holds the vault key through the session's owner
//! ([`crate::session::at_rest_key`]). Without a readable key it runs on in-memory records, as
//! Electron's bootstrap does (`agent/bootstrap.ts:108-114`), and
//! [`AgentStore::history_persisted`] says so. A keychain that comes back moves the store to disk:
//! what the agent kept in memory is written there first, ids and times kept, under the same lock
//! that every operation holds, so a reply streaming at that moment finishes on disk.
//! A streaming message is written on this device only and queued once it is final; a write while
//! the account is not paid is not queued, and [`gate::run_backfill`] queues it when the account
//! turns paid.

mod ephemeral;
pub mod gate;
mod key;
mod sealed;

use std::ops::Deref;
use std::sync::{OnceLock, RwLock, RwLockReadGuard};

pub use key::StoreParts;
pub use memry_core::domain::agent_conversation::{
    Conversation, ConversationPatch, NewConversation,
};
pub use memry_core::domain::agent_message::{Message, MessageEdit, NewMessage, TERMINAL_STATUSES};
pub use memry_core::domain::agent_records::AgentError;

/// The conversation and message operations of Electron's `ConversationStore` and `MessageStore`
/// (`conversation-store.ts:25-44`, `message-store.ts:28-49`), over disk or memory.
pub trait ChatRecords: Send + Sync {
    fn create_conversation(&self, new: &NewConversation<'_>) -> Result<Conversation, AgentError>;
    /// A live conversation.
    fn conversation(&self, id: &str) -> Result<Option<Conversation>, AgentError>;
    /// The live conversations of `vault_id`, most recently updated first.
    fn conversations(&self, vault_id: &str) -> Result<Vec<Conversation>, AgentError>;
    fn update_conversation(
        &self,
        id: &str,
        patch: &ConversationPatch<'_>,
    ) -> Result<Conversation, AgentError>;
    /// `false` when there was no live conversation.
    fn delete_conversation(&self, id: &str) -> Result<bool, AgentError>;
    /// A final message, or one still streaming (`append`).
    fn append_message(&self, new: &NewMessage<'_>) -> Result<Message, AgentError>;
    fn update_streaming(&self, id: &str, edit: &MessageEdit<'_>) -> Result<Message, AgentError>;
    /// Ends a streaming message with a terminal `status` (`markTerminal`).
    fn finalize_message(
        &self,
        id: &str,
        status: &str,
        edit: &MessageEdit<'_>,
    ) -> Result<Message, AgentError>;
    /// The messages of a conversation, oldest first, streaming ones included.
    fn messages(&self, conversation_id: &str) -> Result<Vec<Message>, AgentError>;
}

/// The agent's records: sealed on disk while the vault key is held, in memory otherwise.
pub struct AgentStore {
    records: RwLock<Records>,
    /// The task that waits for the keychain; it ends with the store.
    retry: OnceLock<tokio::task::AbortHandle>,
}

enum Records {
    Memory(ephemeral::Ephemeral),
    Disk(sealed::Sealed),
}

/// The records for one operation. The move to disk waits until it is dropped.
pub struct RecordsGuard<'a>(RwLockReadGuard<'a, Records>);

impl Deref for RecordsGuard<'_> {
    type Target = dyn ChatRecords;

    fn deref(&self) -> &Self::Target {
        match &*self.0 {
            Records::Memory(memory) => memory,
            Records::Disk(disk) => disk,
        }
    }
}

impl AgentStore {
    fn over(records: Records) -> Self {
        Self {
            records: RwLock::new(records),
            retry: OnceLock::new(),
        }
    }

    /// The records writes go to now. Hold the guard for one operation and never take a second
    /// one while holding it: a keychain that comes back swaps the records once no guard is out.
    pub fn records(&self) -> RecordsGuard<'_> {
        RecordsGuard(
            self.records
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    /// `historyPersisted` of the backend statuses (`ipc-agent.ts:297`): whether the transcript
    /// outlives the process.
    pub fn history_persisted(&self) -> bool {
        matches!(*self.records().0, Records::Disk(_))
    }

    /// Writes what the agent kept in memory to `disk`, then moves every later operation there.
    /// On an error the store stays in memory and nothing is lost from it.
    fn persist(&self, disk: sealed::Sealed) -> Result<(), AgentError> {
        let mut records = self
            .records
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Records::Memory(memory) = &*records {
            disk.take_over(memory)?;
        }
        *records = Records::Disk(disk);
        Ok(())
    }
}

impl Drop for AgentStore {
    fn drop(&mut self) {
        if let Some(retry) = self.retry.get() {
            retry.abort();
        }
    }
}

fn is_terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}
