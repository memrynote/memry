//! [`ChatRecords`] on the vault's `data.db`, sealed under the held vault key. The entitlement gate
//! is read inside each write's transaction on the single writer, so a write that read "unpaid"
//! commits before the backfill that follows the turn to "paid" runs, and the backfill queues it.

use memry_core::api::errors::StorageError;
use memry_core::crypto::agent_envelope::AtRestKey;
use memry_core::domain::agent_queue::Queue;
use memry_core::domain::{agent_conversation, agent_message};
use memry_core::storage::Db;
use rusqlite::Connection;

use super::ephemeral::Ephemeral;
use super::gate::EntitlementGate;
use super::{
    AgentError, ChatRecords, Conversation, ConversationPatch, Message, MessageEdit,
    NewConversation, NewMessage, is_terminal, now_ms,
};
use crate::session::at_rest_key::AtRestKeyGuard;

pub(super) struct Sealed {
    pub db: Db,
    pub key: AtRestKey,
    pub device_id: String,
    pub gate: EntitlementGate,
    /// Keeps the key installed while these records are in use.
    pub _guard: AtRestKeyGuard,
}

/// A write's context: the connection, the key, the queue the gate picks, the device and the time.
struct Write<'a> {
    conn: &'a Connection,
    key: &'a AtRestKey,
    queue: Queue,
    device: &'a str,
    now: i64,
}

impl Sealed {
    fn write<T>(
        &self,
        op: impl FnOnce(Write<'_>) -> Result<T, AgentError>,
    ) -> Result<T, AgentError> {
        let done = self.db.call_blocking(|conn| {
            let write = Write {
                conn,
                key: &self.key,
                queue: self.gate.queue(),
                device: &self.device_id,
                now: now_ms(),
            };
            Ok(op(write))
        });
        flatten(done)
    }

    fn read<T>(
        &self,
        op: impl FnOnce(&Connection, &AtRestKey) -> Result<T, AgentError>,
    ) -> Result<T, AgentError> {
        flatten(self.db.read_blocking(|conn| Ok(op(conn, &self.key))))
    }
}

impl Sealed {
    /// Writes what the agent kept in `memory`, ids and times kept, in one transaction: a failure
    /// leaves nothing on disk. Each record is queued as a write made now would be, and a
    /// streaming message stays on this device.
    pub(super) fn take_over(&self, memory: &Ephemeral) -> Result<(), AgentError> {
        let (conversations, messages) = memory.live();
        self.write(|w| {
            let tx = w.conn.unchecked_transaction().map_err(failed)?;
            for conversation in &conversations {
                agent_conversation::import(&tx, w.key, conversation, w.queue, w.device, w.now)?;
            }
            for message in &messages {
                agent_message::import(&tx, w.key, message, w.queue, w.device, w.now)?;
            }
            tx.commit().map_err(failed)
        })
    }
}

fn failed(error: rusqlite::Error) -> AgentError {
    AgentError::Storage(StorageError::Failed {
        what: format!("copying the agent's records to disk: {error}"),
    })
}

fn flatten<T>(done: Result<Result<T, AgentError>, StorageError>) -> Result<T, AgentError> {
    done.map_err(AgentError::Storage)?
}

impl ChatRecords for Sealed {
    fn create_conversation(&self, new: &NewConversation<'_>) -> Result<Conversation, AgentError> {
        self.write(|w| agent_conversation::create(w.conn, w.key, new, w.queue, w.device, w.now))
    }

    fn conversation(&self, id: &str) -> Result<Option<Conversation>, AgentError> {
        self.read(|conn, key| agent_conversation::get(conn, key, id))
    }

    fn conversations(&self, vault_id: &str) -> Result<Vec<Conversation>, AgentError> {
        self.read(|conn, key| agent_conversation::list(conn, key, vault_id))
    }

    fn update_conversation(
        &self,
        id: &str,
        patch: &ConversationPatch<'_>,
    ) -> Result<Conversation, AgentError> {
        self.write(|w| {
            agent_conversation::update_fields(w.conn, w.key, id, patch, w.queue, w.device, w.now)
        })
    }

    fn delete_conversation(&self, id: &str) -> Result<bool, AgentError> {
        self.write(|w| {
            agent_conversation::soft_delete(w.conn, id, w.queue, w.device, w.now)
                .map_err(AgentError::Storage)
        })
    }

    fn append_message(&self, new: &NewMessage<'_>) -> Result<Message, AgentError> {
        self.write(|w| {
            if is_terminal(new.status) {
                agent_message::append(w.conn, w.key, new, w.queue, w.device, w.now)
            } else {
                agent_message::write_local(w.conn, w.key, new, w.device, w.now)
            }
        })
    }

    fn update_streaming(&self, id: &str, edit: &MessageEdit<'_>) -> Result<Message, AgentError> {
        self.write(|w| agent_message::update_streaming(w.conn, w.key, id, edit, w.device, w.now))
    }

    fn finalize_message(
        &self,
        id: &str,
        status: &str,
        edit: &MessageEdit<'_>,
    ) -> Result<Message, AgentError> {
        self.write(|w| {
            agent_message::finalize(w.conn, w.key, id, status, edit, w.queue, w.device, w.now)
        })
    }

    fn messages(&self, conversation_id: &str) -> Result<Vec<Message>, AgentError> {
        self.read(|conn, key| agent_message::get_by_conversation(conn, key, conversation_id))
    }
}
