//! [`ChatRecords`] that never touch the database, the port of Electron's
//! `agent/storage/ephemeral-stores.ts`. The agent runs on these while the vault key cannot be
//! read: the session works end to end and the transcript lives only as long as the process.
//! Writing it under a throwaway key instead would leave rows nothing can ever open.

use std::collections::HashMap;
use std::sync::Mutex;

use memry_core::api::errors::StorageError;

use super::{
    AgentError, ChatRecords, Conversation, ConversationPatch, Message, MessageEdit,
    NewConversation, NewMessage, is_terminal, now_ms,
};

#[derive(Default)]
pub(super) struct Ephemeral {
    /// Each conversation with whether it was deleted.
    conversations: Mutex<HashMap<String, (Conversation, bool)>>,
    messages: Mutex<HashMap<String, Message>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn not_found(what: &str, id: &str) -> AgentError {
    AgentError::Storage(StorageError::NotFound {
        what: format!("no {what} {id}"),
    })
}

fn invalid(what: String) -> AgentError {
    AgentError::Storage(StorageError::Invalid { what })
}

impl Ephemeral {
    fn rewrite(
        &self,
        id: &str,
        status: Option<&str>,
        edit: &MessageEdit<'_>,
    ) -> Result<Message, AgentError> {
        let mut messages = lock(&self.messages);
        let message = messages
            .get_mut(id)
            .ok_or_else(|| not_found("agent message", id))?;
        if is_terminal(&message.status) {
            return Err(invalid(format!("agent message {id} is already terminal")));
        }
        if let Some(content) = edit.content {
            message.content = content.clone();
        }
        if let Some(attachments) = edit.attachments {
            message.attachments = attachments.clone();
        }
        if let Some(status) = status {
            message.status = status.to_owned();
        }
        message.updated_at = now_ms();
        Ok(message.clone())
    }
}

impl Ephemeral {
    /// The live conversations, oldest first, and their messages, oldest first. A deleted
    /// conversation and its messages were never anywhere else, so they are left out.
    pub(super) fn live(&self) -> (Vec<Conversation>, Vec<Message>) {
        let mut conversations: Vec<Conversation> = lock(&self.conversations)
            .values()
            .filter(|(_, deleted)| !deleted)
            .map(|(conversation, _)| conversation.clone())
            .collect();
        conversations.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        let mut messages: Vec<Message> = lock(&self.messages)
            .values()
            .filter(|message| {
                conversations
                    .iter()
                    .any(|conversation| conversation.id == message.conversation_id)
            })
            .cloned()
            .collect();
        messages.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        (conversations, messages)
    }
}

impl ChatRecords for Ephemeral {
    fn create_conversation(&self, new: &NewConversation<'_>) -> Result<Conversation, AgentError> {
        let now = now_ms();
        let conversation = Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            vault_id: new.vault_id.to_owned(),
            title: new.title.to_owned(),
            backend: new.backend.to_owned(),
            backend_model: new.backend_model.map(str::to_owned),
            trust_list: Vec::new(),
            pinned: false,
            created_at: now,
            updated_at: now,
        };
        lock(&self.conversations).insert(conversation.id.clone(), (conversation.clone(), false));
        Ok(conversation)
    }

    fn conversation(&self, id: &str) -> Result<Option<Conversation>, AgentError> {
        Ok(lock(&self.conversations)
            .get(id)
            .filter(|(_, deleted)| !deleted)
            .map(|(conversation, _)| conversation.clone()))
    }

    fn conversations(&self, vault_id: &str) -> Result<Vec<Conversation>, AgentError> {
        let mut live: Vec<Conversation> = lock(&self.conversations)
            .values()
            .filter(|(conversation, deleted)| !deleted && conversation.vault_id == vault_id)
            .map(|(conversation, _)| conversation.clone())
            .collect();
        live.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        Ok(live)
    }

    fn update_conversation(
        &self,
        id: &str,
        patch: &ConversationPatch<'_>,
    ) -> Result<Conversation, AgentError> {
        let mut conversations = lock(&self.conversations);
        let (conversation, _) = conversations
            .get_mut(id)
            .filter(|(_, deleted)| !deleted)
            .ok_or_else(|| not_found("agent conversation", id))?;
        if let Some(title) = patch.title {
            conversation.title = title.to_owned();
        }
        if let Some(backend) = patch.backend {
            conversation.backend = backend.to_owned();
        }
        if let Some(model) = patch.backend_model {
            conversation.backend_model = model.map(str::to_owned);
        }
        if let Some(trust_list) = patch.trust_list {
            conversation.trust_list = trust_list.to_vec();
        }
        if let Some(pinned) = patch.pinned {
            conversation.pinned = pinned;
        }
        conversation.updated_at = now_ms();
        Ok(conversation.clone())
    }

    fn delete_conversation(&self, id: &str) -> Result<bool, AgentError> {
        let mut conversations = lock(&self.conversations);
        let Some((conversation, deleted)) = conversations.get_mut(id).filter(|(_, gone)| !gone)
        else {
            return Ok(false);
        };
        *deleted = true;
        conversation.updated_at = now_ms();
        Ok(true)
    }

    fn append_message(&self, new: &NewMessage<'_>) -> Result<Message, AgentError> {
        let now = now_ms();
        let message = Message {
            id: new
                .id
                .map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned),
            conversation_id: new.conversation_id.to_owned(),
            role: new.role.to_owned(),
            content: new.content.clone(),
            attachments: new.attachments.clone(),
            tool_call_id: new.tool_call_id.map(str::to_owned),
            status: new.status.to_owned(),
            created_at: now,
            updated_at: now,
        };
        lock(&self.messages).insert(message.id.clone(), message.clone());
        Ok(message)
    }

    fn update_streaming(&self, id: &str, edit: &MessageEdit<'_>) -> Result<Message, AgentError> {
        self.rewrite(id, None, edit)
    }

    fn finalize_message(
        &self,
        id: &str,
        status: &str,
        edit: &MessageEdit<'_>,
    ) -> Result<Message, AgentError> {
        if !is_terminal(status) {
            return Err(invalid(format!(
                "agent message status `{status}` is not terminal"
            )));
        }
        self.rewrite(id, Some(status), edit)
    }

    fn messages(&self, conversation_id: &str) -> Result<Vec<Message>, AgentError> {
        let mut found: Vec<Message> = lock(&self.messages)
            .values()
            .filter(|message| message.conversation_id == conversation_id)
            .cloned()
            .collect();
        found.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        Ok(found)
    }
}
