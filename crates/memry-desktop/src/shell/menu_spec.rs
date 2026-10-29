//! The structure of the application menu as data: port of `buildAppMenu`
//! (`apps/desktop/src/main/menu.ts`). The Tauri adapter turns a [`MenuNode`] tree into a muda
//! menu, so the structure per OS is tested here without a display.

use std::collections::BTreeMap;

use super::accelerator::{Binding, binding_to_accelerator, display_shortcut};
use super::menu_table_generated::MENU_COMMANDS;

pub const DOCS_URL: &str = "https://docs.memrynote.com";
pub const DISCORD_URL: &str = "https://discord.gg/NkCvW3uE75";
pub const X_URL: &str = "https://x.com/memrynote";
pub const REDDIT_URL: &str = "https://www.reddit.com/r/MemryNote/";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

/// An item the OS menu system implements itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    CloseWindow,
    BringAllToFront,
    Fullscreen,
}

/// An item whose handler the shell implements, for the roles muda lacks and the links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    NavBack,
    NavForward,
    Reload,
    ToggleDevTools,
    PasteAndMatchStyle,
    Delete,
    StartSpeaking,
    StopSpeaking,
    /// The macOS "Zoom" item: maximize, or restore when maximized.
    ZoomWindow,
    /// The Windows About box (a message with the version).
    AboutDialog,
    OpenUrl(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuNode {
    /// A bridge item: a click sends `MenuCommandInvokedEvent { command: id }` to the renderer.
    /// The accelerator is real only where the shell can hold it (macOS, F1).
    Command {
        id: String,
        label: String,
        accelerator: Option<String>,
    },
    Predefined {
        role: Role,
        label: String,
    },
    Action {
        id: String,
        label: String,
        accelerator: Option<String>,
        action: Action,
    },
    Submenu {
        label: String,
        items: Vec<MenuNode>,
    },
    Separator,
}

/// The translations and values the structure needs.
pub struct MenuInput<'a> {
    pub platform: Platform,
    /// The keyboard overrides of the open vault, by command id.
    pub overrides: &'a BTreeMap<String, Binding>,
    /// `menu:<key>` of the catalog.
    pub t: &'a dyn Fn(&str) -> String,
    /// The build has a web inspector (a debug build), so View lists Toggle Developer Tools.
    pub devtools: bool,
}

struct Builder<'a> {
    input: &'a MenuInput<'a>,
}

impl Builder<'_> {
    fn t(&self, key: &str) -> String {
        (self.input.t)(key)
    }

    fn is_mac(&self) -> bool {
        self.input.platform == Platform::Mac
    }

    /// macOS carries the accelerator as a live key equivalent. Windows and Linux set none, so
    /// the editor still receives its keys, and append the shortcut to the label.
    fn shortcut_parts(
        &self,
        label: String,
        accelerator: Option<String>,
    ) -> (String, Option<String>) {
        match accelerator {
            None => (label, None),
            Some(accel) if self.is_mac() => (label, Some(accel)),
            Some(accel) => (format!("{label}\t{}", display_shortcut(&accel)), None),
        }
    }

    fn cmd(&self, id: &str, label_key: &str, accelerator: Option<String>) -> MenuNode {
        let (label, accelerator) = self.shortcut_parts(self.t(label_key), accelerator);
        MenuNode::Command {
            id: id.to_owned(),
            label,
            accelerator,
        }
    }

    /// The accelerator of a `menuAccelerator` command: the user's rebind, else the default. A
    /// rebind the menu cannot express drops the accelerator rather than keep the default live.
    fn shortcut(&self, id: &str) -> Option<String> {
        let binding = match self.input.overrides.get(id) {
            Some(own) => own.clone(),
            None => {
                let row = MENU_COMMANDS.iter().find(|row| row.id == id)?;
                let default = row.accelerator?;
                if self.is_mac() {
                    default.mac.into()
                } else {
                    default.other.into()
                }
            }
        };
        binding_to_accelerator(&binding, self.is_mac())
    }

    fn cmd_bound(&self, id: &str, label_key: &str) -> MenuNode {
        self.cmd(id, label_key, self.shortcut(id))
    }

    fn plain(&self, id: &str, label_key: &str) -> MenuNode {
        self.cmd(id, label_key, None)
    }

    fn role(&self, role: Role, label_key: &str) -> MenuNode {
        MenuNode::Predefined {
            role,
            label: self.t(label_key),
        }
    }

    fn action(&self, id: &str, label_key: &str, action: Action) -> MenuNode {
        MenuNode::Action {
            id: id.to_owned(),
            label: self.t(label_key),
            accelerator: None,
            action,
        }
    }

    fn submenu(&self, label_key: &str, items: Vec<MenuNode>) -> MenuNode {
        MenuNode::Submenu {
            label: self.t(label_key),
            items,
        }
    }

    fn open_url(&self, id: &str, label_key: &str, url: &str) -> MenuNode {
        self.action(id, label_key, Action::OpenUrl(url.to_owned()))
    }

    fn about(&self) -> MenuNode {
        if self.input.platform == Platform::Windows {
            self.action("app.about", "help.about", Action::AboutDialog)
        } else {
            self.role(Role::About, "help.about")
        }
    }

    fn app_menu(&self) -> MenuNode {
        self.submenu_raw(
            "MemryNote",
            vec![
                self.about(),
                self.plain("app.checkForUpdates", "app.checkForUpdates"),
                MenuNode::Separator,
                self.plain("nav.settings", "app.preferences"),
                MenuNode::Separator,
                self.role(Role::Services, "app.services"),
                MenuNode::Separator,
                self.role(Role::Hide, "app.hide"),
                self.role(Role::HideOthers, "app.hideOthers"),
                self.role(Role::ShowAll, "app.unhide"),
                MenuNode::Separator,
                self.role(Role::Quit, "app.quit"),
            ],
        )
    }

    fn submenu_raw(&self, label: &str, items: Vec<MenuNode>) -> MenuNode {
        MenuNode::Submenu {
            label: label.to_owned(),
            items,
        }
    }

    fn file_menu(&self) -> MenuNode {
        let mut items = vec![
            self.plain("nav.newNote", "file.newNote"),
            self.nav_item(
                "app.navBack",
                "navigation.back",
                "tabs.navBack",
                Action::NavBack,
            ),
            self.nav_item(
                "app.navForward",
                "navigation.forward",
                "tabs.navForward",
                Action::NavForward,
            ),
            self.plain("nav.search", "file.openQuickly"),
            self.plain("nav.commands", "file.commandPalette"),
            MenuNode::Separator,
            self.plain("note.exportPdf", "file.exportPdf"),
            MenuNode::Separator,
            self.cmd_bound("tabs.closeTab", "file.closeTab"),
            // Not the Close Window role: the renderer decides (close the tab, or the window
            // once only Home is left) and closes through the path that flushes first.
            self.plain("app.closeWindow", "file.close"),
        ];
        if !self.is_mac() {
            items.push(MenuNode::Separator);
            items.push(self.plain("nav.settings", "app.preferences"));
            items.push(MenuNode::Separator);
            let quit = if self.input.platform == Platform::Windows {
                "app.exit"
            } else {
                "app.quit"
            };
            items.push(self.role(Role::Quit, quit));
        }
        self.submenu("file.label", items)
    }

    fn nav_item(&self, id: &str, label_key: &str, binding_id: &str, action: Action) -> MenuNode {
        let (label, accelerator) =
            self.shortcut_parts(self.t(label_key), self.shortcut(binding_id));
        MenuNode::Action {
            id: id.to_owned(),
            label,
            accelerator,
            action,
        }
    }

    fn edit_menu(&self) -> MenuNode {
        let windows = self.input.platform == Platform::Windows;
        let redo = if windows {
            "Control+Y"
        } else {
            "CmdOrCtrl+Shift+Z"
        };
        let mut items = vec![
            // Not the undo and redo roles: those drive the webview's own undo stack, which the
            // editor (Yjs owns history) never fills. These bridge items show the shortcut.
            self.cmd("editor.undo", "edit.undo", Some("CmdOrCtrl+Z".to_owned())),
            self.cmd("editor.redo", "edit.redo", Some(redo.to_owned())),
            MenuNode::Separator,
            self.role(Role::Cut, "edit.cut"),
            self.role(Role::Copy, "edit.copy"),
            self.role(Role::Paste, "edit.paste"),
            self.action(
                "edit.pasteAndMatchStyle",
                "edit.pasteAndMatchStyle",
                Action::PasteAndMatchStyle,
            ),
            self.action("edit.delete", "edit.delete", Action::Delete),
            self.select_all(),
            MenuNode::Separator,
            self.plain("note.find", "edit.find"),
        ];
        if self.is_mac() {
            items.push(MenuNode::Separator);
            items.push(self.submenu(
                "edit.speech",
                vec![
                    self.action(
                        "edit.startSpeaking",
                        "edit.startSpeaking",
                        Action::StartSpeaking,
                    ),
                    self.action(
                        "edit.stopSpeaking",
                        "edit.stopSpeaking",
                        Action::StopSpeaking,
                    ),
                ],
            ));
        }
        self.submenu("edit.label", items)
    }

    fn select_all(&self) -> MenuNode {
        let label = self.t("edit.selectAll");
        MenuNode::Predefined {
            role: Role::SelectAll,
            label: if self.is_mac() {
                label
            } else {
                format!("{label}\tCtrl+A")
            },
        }
    }

    fn insert_menu(&self) -> MenuNode {
        self.submenu(
            "insert.label",
            vec![
                self.plain("editor.insertCodeBlock", "insert.codeBlock"),
                self.plain("editor.insertTable", "insert.table"),
                MenuNode::Separator,
                self.plain("editor.insertBulletList", "insert.bulletList"),
                self.plain("editor.insertNumberedList", "insert.numberedList"),
                self.plain("editor.insertTaskList", "insert.taskList"),
                MenuNode::Separator,
                self.plain("editor.insertAttachment", "insert.attachment"),
            ],
        )
    }

    fn format_menu(&self) -> MenuNode {
        let heading =
            |n: u8| self.plain(&format!("editor.heading{n}"), &format!("format.heading{n}"));
        self.submenu(
            "format.label",
            vec![
                heading(1),
                heading(2),
                heading(3),
                heading(4),
                heading(5),
                heading(6),
                self.plain("editor.body", "format.body"),
                MenuNode::Separator,
                self.plain("editor.bold", "format.bold"),
                self.plain("editor.italic", "format.italic"),
                self.plain("editor.code", "format.code"),
                self.plain("editor.highlight", "format.highlight"),
                self.plain("editor.strikethrough", "format.strikethrough"),
            ],
        )
    }

    fn view_menu(&self) -> MenuNode {
        let mut items = vec![self.action("view.reload", "view.reload", Action::Reload)];
        if self.input.devtools {
            items.push(self.action(
                "view.toggleDevTools",
                "view.toggleDevTools",
                Action::ToggleDevTools,
            ));
        }
        items.extend([
            MenuNode::Separator,
            self.cmd_bound("view.actualSize", "view.actualSize"),
            self.cmd_bound("view.zoomIn", "view.zoomIn"),
            self.cmd_bound("view.zoomOut", "view.zoomOut"),
            MenuNode::Separator,
            self.role(Role::Fullscreen, "view.toggleFullscreen"),
            MenuNode::Separator,
            self.plain("view.toggleSidebar", "view.toggleSidebar"),
            self.cmd_bound("view.toggleDayPanel", "view.toggleDayPanel"),
            MenuNode::Separator,
            self.submenu(
                "view.theme",
                vec![
                    self.plain("view.themeLight", "view.themeLight"),
                    self.plain("view.themeDark", "view.themeDark"),
                    self.plain("view.themeWhite", "view.themeWhite"),
                    self.plain("view.themeSystem", "view.themeSystem"),
                ],
            ),
        ]);
        self.submenu("view.label", items)
    }

    fn window_menu(&self) -> MenuNode {
        let mut items = vec![
            self.role(Role::Minimize, "window.minimize"),
            self.action("window.zoom", "window.zoom", Action::ZoomWindow),
        ];
        if self.is_mac() {
            items.push(MenuNode::Separator);
            items.push(self.role(Role::BringAllToFront, "window.front"));
        } else {
            items.push(self.role(Role::CloseWindow, "window.close"));
        }
        self.submenu("window.label", items)
    }

    fn help_menu(&self) -> MenuNode {
        let mut items = Vec::new();
        if !self.is_mac() {
            items.push(self.about());
            items.push(self.plain("app.checkForUpdates", "app.checkForUpdates"));
            items.push(MenuNode::Separator);
        }
        items.push(MenuNode::Action {
            id: "help.documentation".to_owned(),
            label: self.t("help.documentation"),
            // F1 opens the docs from the shell, so no editor key is taken from the page.
            accelerator: Some("F1".to_owned()),
            action: Action::OpenUrl(DOCS_URL.to_owned()),
        });
        items.push(self.plain("view.shortcuts", "help.shortcuts"));
        items.push(MenuNode::Separator);
        items.push(self.open_url("help.joinDiscord", "help.joinDiscord", DISCORD_URL));
        items.push(self.open_url("help.followOnX", "help.followOnX", X_URL));
        items.push(self.open_url("help.redditCommunity", "help.redditCommunity", REDDIT_URL));
        self.submenu("help.label", items)
    }
}

/// The menu bar: macOS app menu, File, Edit, Insert, Format, View, Window, Help.
pub fn build_menu(input: &MenuInput<'_>) -> Vec<MenuNode> {
    let b = Builder { input };
    let mut menus = Vec::new();
    if input.platform == Platform::Mac {
        menus.push(b.app_menu());
    }
    menus.extend([
        b.file_menu(),
        b.edit_menu(),
        b.insert_menu(),
        b.format_menu(),
        b.view_menu(),
        b.window_menu(),
        b.help_menu(),
    ]);
    menus
}

/// Every bridge command id in a tree.
pub fn command_ids(nodes: &[MenuNode]) -> Vec<&str> {
    let mut ids = Vec::new();
    for node in nodes {
        match node {
            MenuNode::Command { id, .. } => ids.push(id.as_str()),
            MenuNode::Submenu { items, .. } => ids.extend(command_ids(items)),
            _ => {}
        }
    }
    ids
}

#[cfg(test)]
mod tests;
