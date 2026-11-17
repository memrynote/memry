//! The agent's conversation and message store (Step 28, #3545), the port of Electron's
//! `apps/desktop/src/main/agent/storage/` and `agent/sync/`. Records are the core's
//! `agent_conversation` and `agent_message` (Step 16, #3533), sealed at rest under the vault key.
//!
//! [`AgentStore::open`] holds the vault key through the session's owner
//! ([`crate::session::at_rest_key`]). Without a readable key it runs on in-memory records, as
//! Electron's bootstrap does (`agent/bootstrap.ts:108-114`), and
//! [`AgentStore::history_persisted`] says so; a keychain that comes back moves new writes to disk.
//! A streaming message is written on this device only and queued once it is final; a write while
//! the account is not paid is not queued, and [`gate::run_backfill`] queues it when the account
//! turns paid.

mod ephemeral;
pub mod gate;
mod key;
mod sealed;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

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
    records: RwLock<Arc<dyn ChatRecords>>,
    persisted: AtomicBool,
}

impl AgentStore {
    fn over(records: Arc<dyn ChatRecords>, persisted: bool) -> Self {
        Self {
            records: RwLock::new(records),
            persisted: AtomicBool::new(persisted),
        }
    }

    /// The records writes go to now. A caller keeps no copy across a turn: a keychain that comes
    /// back swaps them.
    pub fn records(&self) -> Arc<dyn ChatRecords> {
        Arc::clone(
            &self
                .records
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    /// `historyPersisted` of the backend statuses (`ipc-agent.ts:297`): whether the transcript
    /// outlives the process.
    pub fn history_persisted(&self) -> bool {
        self.persisted.load(Ordering::SeqCst)
    }

    fn persist(&self, records: Arc<dyn ChatRecords>) {
        *self
            .records
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = records;
        self.persisted.store(true, Ordering::SeqCst);
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
