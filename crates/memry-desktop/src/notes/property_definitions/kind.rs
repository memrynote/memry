//! A definition's type and what it carries: the option lists, and the kind a create or an
//! update makes (`normalizeDefinition` of Electron).

use super::record::default_categories;
use super::view::{DefinitionType, DefinitionsError, OptionInput};
use crate::vault::properties_file::{PropertyKind, SelectOption};

pub(super) fn option(input: OptionInput) -> SelectOption {
    SelectOption {
        value: input.value,
        color: input.color,
        default: input.default,
    }
}

/// An option of `add_option`, `add_status_option`: `PropertyOptionInputSchema`, which keeps
/// only the value and the color.
pub(super) fn new_option(input: OptionInput) -> Result<SelectOption, DefinitionsError> {
    if input.value.is_empty() || input.color.is_empty() {
        return Err(DefinitionsError::Invalid(
            "an option needs a value and a color",
        ));
    }
    Ok(SelectOption {
        default: None,
        ..option(input)
    })
}

pub(super) fn option_list(kind: &mut PropertyKind) -> Option<&mut Vec<SelectOption>> {
    match kind {
        PropertyKind::Text(options)
        | PropertyKind::Number(options)
        | PropertyKind::Checkbox(options)
        | PropertyKind::Url(options)
        | PropertyKind::Select(options)
        | PropertyKind::Multiselect(options) => Some(options),
        PropertyKind::Status(_) | PropertyKind::Date { .. } | PropertyKind::Project => None,
    }
}

/// The option list of a type that has one.
pub(super) fn options_of(kind: Option<&PropertyKind>) -> Vec<SelectOption> {
    kind.and_then(|kind| option_list(&mut kind.clone()).map(std::mem::take))
        .unwrap_or_default()
}

/// Every option list of the definition: the type's own, or each status category's.
pub(super) fn each_list(kind: &mut PropertyKind, mut change: impl FnMut(&mut Vec<SelectOption>)) {
    if let PropertyKind::Status(categories) = kind {
        for category in [
            &mut categories.todo,
            &mut categories.in_progress,
            &mut categories.done,
        ] {
            change(&mut category.options);
        }
    } else if let Some(options) = option_list(kind) {
        change(options);
    }
}

/// The kind of type `wanted`, keeping what `prior` (the definition it replaces) carries that
/// the type has too; `options` replaces an option list. `normalizeDefinition` of Electron.
pub(super) fn kind_of(
    wanted: DefinitionType,
    options: Option<Vec<OptionInput>>,
    prior: Option<&PropertyKind>,
) -> PropertyKind {
    let list = || {
        options.map_or_else(
            || options_of(prior),
            |options| options.into_iter().map(option).collect(),
        )
    };
    match wanted {
        DefinitionType::Text => PropertyKind::Text(list()),
        DefinitionType::Number => PropertyKind::Number(list()),
        DefinitionType::Checkbox => PropertyKind::Checkbox(list()),
        DefinitionType::Url => PropertyKind::Url(list()),
        DefinitionType::Select => PropertyKind::Select(list()),
        DefinitionType::Multiselect => PropertyKind::Multiselect(list()),
        DefinitionType::Status => match prior {
            Some(PropertyKind::Status(categories)) => PropertyKind::Status(categories.clone()),
            _ => PropertyKind::Status(default_categories()),
        },
        DefinitionType::Project => PropertyKind::Project,
        DefinitionType::Date => PropertyKind::Date {
            show_on_calendar: matches!(
                prior,
                Some(PropertyKind::Date {
                    show_on_calendar: true
                })
            ),
        },
    }
}

pub(super) fn type_of(kind: &PropertyKind) -> DefinitionType {
    match kind {
        PropertyKind::Text(_) => DefinitionType::Text,
        PropertyKind::Number(_) => DefinitionType::Number,
        PropertyKind::Checkbox(_) => DefinitionType::Checkbox,
        PropertyKind::Url(_) => DefinitionType::Url,
        PropertyKind::Select(_) => DefinitionType::Select,
        PropertyKind::Multiselect(_) => DefinitionType::Multiselect,
        PropertyKind::Status(_) => DefinitionType::Status,
        PropertyKind::Date { .. } => DefinitionType::Date,
        PropertyKind::Project => DefinitionType::Project,
    }
}
