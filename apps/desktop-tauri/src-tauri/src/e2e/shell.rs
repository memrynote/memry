//! Native menus under test. WebDriver cannot click a native menu, so a spec reads the built
//! menu with `e2e_menu_tree`, runs an item with `e2e_menu_activate`, and drives context menus
//! through a queued answer.

use std::sync::{Mutex, PoisonError};

use memry_desktop::shell::menu_spec::MenuNode;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, Wry};

use crate::commands::error::CommandError;
use crate::menu::popup::ContextMenuItem;

/// The next answer a context menu gives, and the items of the last one shown.
#[derive(Default)]
pub struct ContextMenuProbe {
    next: Mutex<Option<Option<String>>>,
    last: Mutex<Vec<ContextMenuItem>>,
}

pub fn context_menu_override<R: Runtime>(
    app: &AppHandle<R>,
    items: &[ContextMenuItem],
) -> Option<Option<String>> {
    let probe = app.try_state::<ContextMenuProbe>()?;
    *probe.last.lock().unwrap_or_else(PoisonError::into_inner) = items.to_vec();
    probe
        .next
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
}

/// Queues the answer of the next context menu: an item id, or `null` for a dismissal.
#[tauri::command]
pub fn e2e_set_next_context_menu_selection<R: Runtime>(
    app: AppHandle<R>,
    selection: Option<String>,
) -> Result<(), CommandError> {
    let probe = app
        .try_state::<ContextMenuProbe>()
        .ok_or_else(super::disabled)?;
    *probe.next.lock().unwrap_or_else(PoisonError::into_inner) = Some(selection);
    Ok(())
}

/// The items of the last context menu.
#[tauri::command]
pub fn e2e_last_context_menu_items<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ContextMenuItem>, CommandError> {
    let probe = app
        .try_state::<ContextMenuProbe>()
        .ok_or_else(super::disabled)?;
    Ok(probe
        .last
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuNodeInfo {
    pub kind: &'static str,
    pub id: Option<String>,
    pub label: String,
    pub accelerator: Option<String>,
    pub enabled: bool,
    pub children: Vec<MenuNodeInfo>,
}

fn info(node: &MenuNode) -> MenuNodeInfo {
    let leaf =
        |kind, id: Option<&String>, label: &String, accelerator: &Option<String>| MenuNodeInfo {
            kind,
            id: id.cloned(),
            label: label.clone(),
            accelerator: accelerator.clone(),
            enabled: true,
            children: Vec::new(),
        };
    match node {
        MenuNode::Command {
            id,
            label,
            accelerator,
        } => leaf("command", Some(id), label, accelerator),
        MenuNode::Action {
            id,
            label,
            accelerator,
            ..
        } => leaf("action", Some(id), label, accelerator),
        MenuNode::Predefined { label, .. } => leaf("predefined", None, label, &None),
        MenuNode::Separator => leaf("separator", None, &String::new(), &None),
        MenuNode::Submenu { label, items } => MenuNodeInfo {
            children: items.iter().map(info).collect(),
            ..leaf("submenu", None, label, &None)
        },
    }
}

/// The built menu: labels, ids, accelerators and enabled flags.
#[tauri::command]
pub fn e2e_menu_tree(app: AppHandle<Wry>) -> Result<Vec<MenuNodeInfo>, CommandError> {
    Ok(crate::menu::tree(&app).iter().map(info).collect())
}

/// Runs the item `id` as a click would.
#[tauri::command]
pub fn e2e_menu_activate(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    crate::menu::activate(&app, &id);
    Ok(())
}
