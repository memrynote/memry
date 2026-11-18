//! Work an item type needs done before its record goes out, chapter 14 §14.8.1 (#3022).
//!
//! A canvas holds the chunks of the images it shows before its scene is pushed, so the pushed
//! sidecar never names chunks a peer's release freed (`prepareCanvasItems`,
//! `apps/desktop/src/main/sync/engine/push-coordinator.ts:745-786`). Step 30 (#3547) registers
//! the canvas hook over [`crate::sync::attachments::holds`]; this module owns the deferral
//! policy. A deferred item stays queued with its attempts untouched and is not claimed again in
//! the same wave. After [`MAX_HOLD_DEFERRALS`] deferrals in a row it pushes without the hold, as
//! every push did before holds existed. A delete never waits. With no hook registered nothing
//! waits.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use super::PushCoordinator;
use crate::sync::outbox::{self, Collapsed};

/// Push waves an item waits for its hook before it goes out without it,
/// `MAX_CANVAS_HOLD_DEFERRALS` (`push-coordinator.ts:48`).
pub const MAX_HOLD_DEFERRALS: u32 = 5;

/// What a hook decided for one item in one wave.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldDecision {
    /// Push it now: the hold is in place, or failed in a way a retry cannot fix.
    Push,
    /// The hold or the re-upload could not finish; try again next wave.
    Defer,
}

/// Runs before an item of the type it is registered for is read and sealed.
#[async_trait::async_trait]
pub trait PrePushHook: Send + Sync {
    async fn before_push(&self, item_type: &str, item_id: &str) -> HoldDecision;
}

/// What one push wave deferred. An edit during the wave replaces the queued row with a new
/// outbox id; the item key keeps that row waiting too, so an item costs one hook call and one
/// deferral per wave (`rejectedThisCycle`, `push-coordinator.ts:257-259`).
#[derive(Default)]
pub(super) struct WaveDeferrals {
    pub(super) rows: Vec<i64>,
    items: HashSet<(String, String)>,
}

/// The registered hooks and the consecutive deferrals of each item. In memory, as in Electron:
/// a restart starts every count again.
#[derive(Default)]
pub(super) struct PrePushHooks {
    hooks: HashMap<String, Arc<dyn PrePushHook>>,
    deferrals: Mutex<HashMap<(String, String), u32>>,
}

impl PrePushHooks {
    /// The items that go out in this batch. A deferred item's outbox ids are added to
    /// `waiting`, which keeps them out of the rest of the wave.
    pub(super) async fn admit(
        &self,
        items: Vec<Collapsed>,
        waiting: &mut WaveDeferrals,
    ) -> Vec<Collapsed> {
        let mut ready = Vec::with_capacity(items.len());
        for item in items {
            let row = &item.row;
            let hook = match self.hooks.get(&row.item_type) {
                Some(hook) if row.op != outbox::OP_DELETE => hook,
                _ => {
                    ready.push(item);
                    continue;
                }
            };
            let key = (row.item_type.clone(), row.item_id.clone());
            if waiting.items.contains(&key) {
                waiting.rows.extend(item.ids());
                continue;
            }
            let decision = hook.before_push(&row.item_type, &row.item_id).await;
            let mut deferrals = self.deferrals.lock().unwrap_or_else(|e| e.into_inner());
            if decision == HoldDecision::Push {
                deferrals.remove(&key);
                ready.push(item);
                continue;
            }
            let count = deferrals.get(&key).copied().unwrap_or(0) + 1;
            if count >= MAX_HOLD_DEFERRALS {
                eprintln!(
                    "memry-core: the pre-push hook of a {} kept deferring it; pushing without it \
                     after {count} waves",
                    row.item_type
                );
                deferrals.remove(&key);
                ready.push(item);
                continue;
            }
            deferrals.insert(key.clone(), count);
            waiting.items.insert(key);
            waiting.rows.extend(item.ids());
        }
        ready
    }
}

impl PushCoordinator {
    /// Runs `hook` before every non-delete push of an `item_type` record (§14.8.1). One hook
    /// per type; a later registration replaces the earlier one.
    pub fn with_pre_push_hook(mut self, item_type: &str, hook: Arc<dyn PrePushHook>) -> Self {
        self.pre_push.hooks.insert(item_type.to_owned(), hook);
        self
    }
}

#[cfg(test)]
mod tests;
