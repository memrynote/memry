use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::shell::accelerator::Modifiers;

fn en(key: &str) -> String {
    crate::i18n::t("en", &format!("menu:{key}"), &Default::default())
}

fn build(platform: Platform, overrides: &BTreeMap<String, Binding>) -> Vec<MenuNode> {
    build_menu(&MenuInput {
        platform,
        overrides,
        t: &en,
        devtools: true,
    })
}

fn labels(nodes: &[MenuNode]) -> Vec<String> {
    nodes
        .iter()
        .map(|n| match n {
            MenuNode::Submenu { label, .. } => label.clone(),
            _ => String::new(),
        })
        .collect()
}

fn find<'a>(nodes: &'a [MenuNode], id: &str) -> Option<&'a MenuNode> {
    nodes.iter().find_map(|n| match n {
        MenuNode::Command { id: i, .. } | MenuNode::Action { id: i, .. } if i == id => Some(n),
        MenuNode::Submenu { items, .. } => find(items, id),
        _ => None,
    })
}

fn accel(node: &MenuNode) -> Option<&str> {
    match node {
        MenuNode::Command { accelerator, .. } | MenuNode::Action { accelerator, .. } => {
            accelerator.as_deref()
        }
        _ => None,
    }
}

fn label(node: &MenuNode) -> &str {
    match node {
        MenuNode::Command { label, .. }
        | MenuNode::Action { label, .. }
        | MenuNode::Predefined { label, .. } => label,
        _ => "",
    }
}

#[test]
fn top_level_menus_per_os() {
    let none = BTreeMap::new();
    assert_eq!(
        labels(&build(Platform::Mac, &none)),
        [
            "MemryNote",
            "File",
            "Edit",
            "Insert",
            "Format",
            "View",
            "Window",
            "Help"
        ]
    );
    for platform in [Platform::Windows, Platform::Linux] {
        assert_eq!(
            labels(&build(platform, &none)),
            ["File", "Edit", "Insert", "Format", "View", "Window", "Help"]
        );
    }
}

#[test]
fn every_generated_menu_command_is_listed_and_nothing_else() {
    let none = BTreeMap::new();
    let mut listed = BTreeSet::new();
    for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
        let menu = build(platform, &none);
        let ids = command_ids(&menu);
        let unique: BTreeSet<_> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len(), "{platform:?} repeats a command id");
        listed.extend(ids.into_iter().map(str::to_owned));
    }
    let table: BTreeSet<String> = MENU_COMMANDS
        .iter()
        .filter(|row| row.menu)
        .map(|row| row.id.to_owned())
        .collect();
    assert_eq!(listed, table);
}

#[test]
fn preferences_and_quit_live_in_the_app_menu_on_macos_and_in_file_elsewhere() {
    let none = BTreeMap::new();
    let mac = build(Platform::Mac, &none);
    let MenuNode::Submenu { items, .. } = &mac[0] else {
        panic!("no app menu")
    };
    assert!(find(items, "nav.settings").is_some());
    assert!(items.iter().any(|n| matches!(
        n,
        MenuNode::Predefined {
            role: Role::Quit,
            ..
        }
    )));
    let MenuNode::Submenu { items: file, .. } = &mac[1] else {
        panic!()
    };
    assert!(find(file, "nav.settings").is_none());

    for (platform, quit) in [(Platform::Windows, "Exit"), (Platform::Linux, "Quit")] {
        let menu = build(platform, &none);
        let MenuNode::Submenu { items: file, .. } = &menu[0] else {
            panic!()
        };
        assert!(find(file, "nav.settings").is_some());
        let last = file.last().unwrap();
        assert!(matches!(
            last,
            MenuNode::Predefined {
                role: Role::Quit,
                ..
            }
        ));
        assert_eq!(label(last), quit);
    }
}

#[test]
fn about_and_updates_sit_in_help_off_macos_and_about_is_a_dialog_on_windows() {
    let none = BTreeMap::new();
    let windows = build(Platform::Windows, &none);
    assert!(matches!(
        find(&windows, "app.about"),
        Some(MenuNode::Action {
            action: Action::AboutDialog,
            ..
        })
    ));
    let linux = build(Platform::Linux, &none);
    assert!(find(&linux, "app.about").is_none());
    let help = linux.last().unwrap();
    let MenuNode::Submenu { items, .. } = help else {
        panic!()
    };
    assert!(matches!(
        items[0],
        MenuNode::Predefined {
            role: Role::About,
            ..
        }
    ));
    assert!(find(items, "app.checkForUpdates").is_some());
    let mac = build(Platform::Mac, &none);
    let MenuNode::Submenu { items, .. } = mac.last().unwrap() else {
        panic!()
    };
    assert!(find(items, "app.checkForUpdates").is_none());
}

#[test]
fn only_macos_has_the_speech_submenu_and_front() {
    let none = BTreeMap::new();
    for (platform, expected) in [
        (Platform::Mac, true),
        (Platform::Windows, false),
        (Platform::Linux, false),
    ] {
        let menu = build(platform, &none);
        assert_eq!(find(&menu, "edit.startSpeaking").is_some(), expected);
        let has_front = format!("{menu:?}").contains("BringAllToFront");
        assert_eq!(has_front, expected);
    }
}

#[test]
fn help_lists_documentation_on_f1_shortcuts_and_the_community_links() {
    let none = BTreeMap::new();
    for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
        let menu = build(platform, &none);
        let docs = find(&menu, "help.documentation").unwrap();
        assert_eq!(accel(docs), Some("F1"));
        assert!(matches!(
            docs,
            MenuNode::Action { action: Action::OpenUrl(url), .. } if url == DOCS_URL
        ));
        assert!(find(&menu, "view.shortcuts").is_some());
        for id in ["help.joinDiscord", "help.followOnX", "help.redditCommunity"] {
            assert!(find(&menu, id).is_some(), "{id}");
        }
    }
}

#[test]
fn macos_sets_live_accelerators_and_the_others_append_the_shortcut_to_the_label() {
    let none = BTreeMap::new();
    let mac = build(Platform::Mac, &none);
    assert_eq!(
        accel(find(&mac, "tabs.closeTab").unwrap()),
        Some("CmdOrCtrl+W")
    );
    assert_eq!(label(find(&mac, "tabs.closeTab").unwrap()), "Close Tab");
    for platform in [Platform::Windows, Platform::Linux] {
        let menu = build(platform, &none);
        let close = find(&menu, "tabs.closeTab").unwrap();
        assert_eq!(accel(close), None);
        assert_eq!(label(close), "Close Tab\tCtrl+W");
        assert_eq!(accel(find(&menu, "view.zoomIn").unwrap()), None);
    }
}

#[test]
fn fixed_display_values_for_undo_redo_and_select_all() {
    let none = BTreeMap::new();
    let mac = build(Platform::Mac, &none);
    assert_eq!(
        accel(find(&mac, "editor.undo").unwrap()),
        Some("CmdOrCtrl+Z")
    );
    assert_eq!(
        accel(find(&mac, "editor.redo").unwrap()),
        Some("CmdOrCtrl+Shift+Z")
    );
    let win = build(Platform::Windows, &none);
    assert_eq!(label(find(&win, "editor.redo").unwrap()), "Redo\tCtrl+Y");
    assert_eq!(label(find(&win, "editor.undo").unwrap()), "Undo\tCtrl+Z");
    let linux = build(Platform::Linux, &none);
    assert_eq!(
        label(find(&linux, "editor.redo").unwrap()),
        "Redo\tCtrl+Shift+Z"
    );
}

#[test]
fn a_rebind_replaces_the_default_and_an_inexpressible_one_drops_it() {
    let mut overrides = BTreeMap::new();
    overrides.insert(
        "tabs.closeTab".to_owned(),
        Binding {
            key: "q".to_owned(),
            modifiers: Modifiers {
                meta: true,
                shift: true,
                ..Modifiers::default()
            },
        },
    );
    overrides.insert(
        "view.zoomIn".to_owned(),
        Binding {
            key: "∑".to_owned(),
            modifiers: Modifiers {
                meta: true,
                ..Modifiers::default()
            },
        },
    );
    let mac = build(Platform::Mac, &overrides);
    assert_eq!(
        accel(find(&mac, "tabs.closeTab").unwrap()),
        Some("CmdOrCtrl+Shift+Q")
    );
    assert_eq!(accel(find(&mac, "view.zoomIn").unwrap()), None);
    let win = build(Platform::Windows, &overrides);
    assert_eq!(
        label(find(&win, "tabs.closeTab").unwrap()),
        "Close Tab\tCtrl+Shift+Q"
    );
    assert_eq!(label(find(&win, "view.zoomIn").unwrap()), "Zoom In");
}

#[test]
fn developer_tools_are_listed_only_in_a_build_with_the_inspector_and_reload_always() {
    let none = BTreeMap::new();
    for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
        for devtools in [true, false] {
            let menu = build_menu(&MenuInput {
                platform,
                overrides: &none,
                t: &en,
                devtools,
            });
            assert_eq!(
                find(&menu, "view.toggleDevTools").is_some(),
                devtools,
                "{platform:?}"
            );
            assert!(matches!(
                find(&menu, "view.reload"),
                Some(MenuNode::Action {
                    action: Action::Reload,
                    ..
                })
            ));
        }
    }
}

#[test]
fn labels_come_from_the_catalog_in_the_requested_locale() {
    let none = BTreeMap::new();
    let tr = |key: &str| crate::i18n::t("tr", &format!("menu:{key}"), &Default::default());
    let menu = build_menu(&MenuInput {
        platform: Platform::Linux,
        overrides: &none,
        t: &tr,
        devtools: true,
    });
    assert_ne!(labels(&menu)[0], "File");
    assert!(!labels(&menu)[0].starts_with("menu:"));
}
