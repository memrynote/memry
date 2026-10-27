//! A [`MenuNode`] tree as a muda menu.

use memry_desktop::shell::menu_spec::{MenuNode, Role};
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Wry};

const APP_NAME: &str = "MemryNote (Beta)";

/// The calendar year, for the About panel's copyright line.
fn current_year() -> i64 {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0));
    // Days since 1970-01-01 to a civil year (Hinnant's algorithm).
    let z = seconds.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    yoe + era * 400 + i64::from(month <= 2)
}

fn about_metadata(app: &AppHandle<Wry>) -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some(APP_NAME.to_owned()),
        version: Some(app.package_info().version.to_string()),
        copyright: Some(format!("(c) {} MemryNote", current_year())),
        ..AboutMetadata::default()
    }
}

fn predefined(
    app: &AppHandle<Wry>,
    role: Role,
    label: &str,
) -> tauri::Result<PredefinedMenuItem<Wry>> {
    let text = Some(label);
    match role {
        Role::About => PredefinedMenuItem::about(app, text, Some(about_metadata(app))),
        Role::Services => PredefinedMenuItem::services(app, text),
        Role::Hide => PredefinedMenuItem::hide(app, text),
        Role::HideOthers => PredefinedMenuItem::hide_others(app, text),
        Role::ShowAll => PredefinedMenuItem::show_all(app, text),
        Role::Quit => PredefinedMenuItem::quit(app, text),
        Role::Cut => PredefinedMenuItem::cut(app, text),
        Role::Copy => PredefinedMenuItem::copy(app, text),
        Role::Paste => PredefinedMenuItem::paste(app, text),
        Role::SelectAll => PredefinedMenuItem::select_all(app, text),
        Role::Minimize => PredefinedMenuItem::minimize(app, text),
        Role::CloseWindow => PredefinedMenuItem::close_window(app, text),
        Role::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, text),
        Role::Fullscreen => PredefinedMenuItem::fullscreen(app, text),
    }
}

/// An item with an accelerator muda cannot parse keeps working without it.
fn item(
    app: &AppHandle<Wry>,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    match MenuItem::with_id(app, id, label, true, accelerator) {
        Ok(item) => Ok(item),
        Err(error) if accelerator.is_some() => {
            tracing::warn!(
                scope = "Menu",
                id,
                ?accelerator,
                "accelerator dropped: {error}"
            );
            MenuItem::with_id(app, id, label, true, None::<&str>)
        }
        Err(error) => Err(error),
    }
}

fn build_item(app: &AppHandle<Wry>, node: &MenuNode) -> tauri::Result<MenuItemKind<Wry>> {
    Ok(match node {
        MenuNode::Command {
            id,
            label,
            accelerator,
        }
        | MenuNode::Action {
            id,
            label,
            accelerator,
            ..
        } => item(app, id, label, accelerator.as_deref())?.kind(),
        MenuNode::Predefined { role, label } => predefined(app, *role, label)?.kind(),
        MenuNode::Separator => PredefinedMenuItem::separator(app)?.kind(),
        MenuNode::Submenu { label, items } => {
            let children = items
                .iter()
                .map(|child| build_item(app, child))
                .collect::<tauri::Result<Vec<_>>>()?;
            let refs: Vec<&dyn IsMenuItem<Wry>> =
                children.iter().map(|c| c as &dyn IsMenuItem<Wry>).collect();
            Submenu::with_items(app, label, true, &refs)?.kind()
        }
    })
}

pub fn build(app: &AppHandle<Wry>, tree: &[MenuNode]) -> tauri::Result<Menu<Wry>> {
    let top = tree
        .iter()
        .map(|node| build_item(app, node))
        .collect::<tauri::Result<Vec<_>>>()?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = top.iter().map(|c| c as &dyn IsMenuItem<Wry>).collect();
    Menu::with_items(app, &refs)
}

#[cfg(test)]
mod tests {
    use super::current_year;

    #[test]
    fn the_year_is_plausible() {
        assert!((2025..2200).contains(&current_year()));
    }
}
