//! Context menus for the renderer (`window.api.showContextMenu`). Item ids are tagged
//! `ctx:<request>:<item>`; the app-level menu event handler forwards a click to the pending
//! request. A request resolves with the clicked item id, or `None` when the menu closed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{ContextMenu, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};

use crate::commands::error::{CommandError, ErrorKind};

/// After a modal popup returns, a click can still be in flight.
const LATE_CLICK: Duration = Duration::from_millis(100);
/// Linux pops the menu up asynchronously: the request waits for a click, the next popup, or
/// this long.
const LINUX_WAIT: Duration = Duration::from_secs(120);
const TAG: &str = "ctx:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Normal,
    Separator,
}

/// The item shape of `window.api.showContextMenu`: `{ id, label, accelerator, disabled, type }`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItem {
    pub id: String,
    pub label: String,
    pub accelerator: Option<String>,
    pub disabled: Option<bool>,
    #[serde(rename = "type")]
    pub kind: Option<ItemKind>,
}

#[derive(Default)]
pub struct ContextMenuBroker {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<String>>>,
}

impl ContextMenuBroker {
    fn begin(&self) -> (u64, Receiver<String>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        // A new popup closes the previous one: its waiter sees a disconnect and answers None.
        pending.clear();
        pending.insert(id, tx);
        (id, rx)
    }

    fn finish(&self, request: u64) {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&request);
    }

    fn choose(&self, request: u64, item: String) {
        let pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(tx) = pending.get(&request) {
            let _ = tx.send(item);
        }
    }
}

fn tagged(request: u64, item: &str) -> String {
    format!("{TAG}{request}:{item}")
}

/// Splits a tagged id into its request and item.
fn untag(id: &str) -> Option<(u64, &str)> {
    let rest = id.strip_prefix(TAG)?;
    let (request, item) = rest.split_once(':')?;
    Some((request.parse().ok()?, item))
}

/// Routes a context menu click. `true` when `id` was one.
pub fn resolve(app: &AppHandle<Wry>, id: &str) -> bool {
    let Some((request, item)) = untag(id) else {
        return false;
    };
    if let Some(broker) = app.try_state::<ContextMenuBroker>() {
        broker.choose(request, item.to_owned());
    }
    true
}

fn build(
    app: &AppHandle<Wry>,
    request: u64,
    items: &[ContextMenuItem],
) -> tauri::Result<Menu<Wry>> {
    let mut built: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for item in items {
        if item.kind == Some(ItemKind::Separator) {
            built.push(Box::new(PredefinedMenuItem::separator(app)?));
            continue;
        }
        let id = tagged(request, &item.id);
        let enabled = !item.disabled.unwrap_or(false);
        let menu_item =
            match MenuItem::with_id(app, &id, &item.label, enabled, item.accelerator.as_deref()) {
                Ok(menu_item) => menu_item,
                // An accelerator muda cannot parse is display-only: the item still works.
                Err(_) => MenuItem::with_id(app, &id, &item.label, enabled, None::<&str>)?,
            };
        built.push(Box::new(menu_item));
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Shows `items` at the pointer and waits for the answer.
pub async fn show(
    app: AppHandle<Wry>,
    window: WebviewWindow<Wry>,
    items: Vec<ContextMenuItem>,
) -> Result<Option<String>, CommandError> {
    #[cfg(feature = "e2e")]
    if let Some(answer) = crate::e2e::context_menu_override(&app, &items) {
        return Ok(answer);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let broker = app.state::<ContextMenuBroker>();
        let (request, rx) = broker.begin();
        let menu = build(&app, request, &items).map_err(failure)?;
        let outcome = menu.popup(window.as_ref().window().clone());
        let wait = if cfg!(target_os = "linux") {
            LINUX_WAIT
        } else {
            LATE_CLICK
        };
        let chosen = outcome
            .is_ok()
            .then(|| rx.recv_timeout(wait).ok())
            .flatten();
        broker.finish(request);
        outcome.map_err(failure)?;
        Ok(chosen)
    })
    .await
    .map_err(|error| CommandError::new(ErrorKind::Internal, "task_failed", error.to_string()))?
}

fn failure(error: tauri::Error) -> CommandError {
    CommandError::new(ErrorKind::Internal, "context_menu", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_even_when_the_item_id_has_colons() {
        assert_eq!(
            untag(&tagged(7, "tab:close:all")),
            Some((7, "tab:close:all"))
        );
        assert_eq!(untag("nav.newNote"), None);
        assert_eq!(untag("ctx:x:y"), None);
    }

    #[test]
    fn a_choice_reaches_only_the_pending_request() {
        let broker = ContextMenuBroker::default();
        let (first, first_rx) = broker.begin();
        broker.choose(first, "a".into());
        assert_eq!(first_rx.try_recv().as_deref(), Ok("a"));
        let (second, second_rx) = broker.begin();
        // The first request was replaced, so its waiter disconnects and answers None.
        assert!(first_rx.recv_timeout(Duration::from_millis(10)).is_err());
        broker.choose(first, "late".into());
        broker.choose(second, "b".into());
        assert_eq!(second_rx.try_recv().as_deref(), Ok("b"));
    }
}
