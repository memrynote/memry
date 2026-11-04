//! A pulled definition into the file (`applyRemoteUpsert` / `applyRemoteDelete` of
//! `vault/property-definitions.ts`, #2896): the record a pull changed replaces the file's
//! definition of its name, a date keeping this device's calendar flag, and a record a pull
//! deleted leaves the file. Which records a pull changed is the core's
//! [`memry_core::domain::property_admin::mirror`].

use memry_core::domain::property_admin::mirror::Pulled;

use super::record::definition_of;
use crate::vault::properties_file::{Definitions, PropertyKind};

/// Takes `pulled` into `definitions`; returns the names whose definition changed.
///
/// - A live record replaces the file's definition. One whose type the file does not hold
///   (`relation`, a type of a newer build) leaves the file as it is, as Electron's
///   `applyRemoteUpsert` does.
/// - A deleted record leaves the file.
/// - A record this device wrote apart from the file, which the file never took
///   ([`Pulled::file_wins`]): the file wins for a name it lists, and a live record of a name it
///   does not list joins it, as Electron's reload folds its rows in. Every other record wins,
///   the server's ones on a first run included.
pub(super) fn settle_into(definitions: &mut Definitions, pulled: &[Pulled]) -> Vec<String> {
    let mut changed = Vec::new();
    for pulled in pulled {
        let name = pulled.name.as_str();
        let held = definitions.get(name);
        if pulled.file_wins && held.is_some() {
            continue;
        }
        match pulled.record.as_ref() {
            Some(record) => {
                let Some(mut next) = definition_of(record) else {
                    continue;
                };
                if let (
                    PropertyKind::Date { show_on_calendar },
                    Some(PropertyKind::Date {
                        show_on_calendar: shown,
                    }),
                ) = (&mut next.kind, held.map(|held| &held.kind))
                {
                    *show_on_calendar = *shown;
                }
                if held != Some(&next) {
                    definitions.insert(name.to_owned(), next);
                    changed.push(pulled.name.clone());
                }
            }
            None => {
                if definitions.remove(name).is_some() {
                    changed.push(pulled.name.clone());
                }
            }
        }
    }
    changed
}
