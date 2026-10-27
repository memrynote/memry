//! The row types of the generated menu table (`menu_table.generated.rs`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BindingRow {
    pub key: &'static str,
    pub meta: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

/// A default binding, per platform (`meta` already means Ctrl off macOS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultBinding {
    pub mac: BindingRow,
    pub other: BindingRow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MenuCommandRow {
    pub id: &'static str,
    pub group: &'static str,
    /// The menu lists the command as an item (`menu: true`).
    pub menu: bool,
    /// Set for the commands whose default binding the menu shows (`menuAccelerator`).
    pub accelerator: Option<DefaultBinding>,
}
