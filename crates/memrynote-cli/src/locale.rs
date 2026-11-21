//! `locale get|set|list` (`runLocale`, `apps/cli/src/cli-commands-library.ts:84-98`).
//!
//! `get` and `set` read and write the vault's settings and `.memry/config.json`
//! (`apps/cli/src/app-core/locale.ts`), so they wait for the vault open of stage B.

use serde_json::Value;

use crate::output::print;
use crate::parse::ParsedCli;
use crate::{CliIo, CliResult, not_ported};

pub fn run(parsed: &ParsedCli, io: &mut dyn CliIo) -> CliResult {
    match parsed.subcommand.as_deref() {
        Some("list") => {
            // `SUPPORTED_LOCALES` of `@memry/contracts/locale-api`, in its order.
            let locales = memry_desktop::locale::SUPPORTED
                .iter()
                .map(|locale| Value::from(*locale))
                .collect();
            print(io, parsed.json, Some(&Value::Array(locales)));
            Ok(())
        }
        Some("get" | "set") => Err(not_ported(parsed)),
        _ => Err("Usage: memrynote [--vault <path>] locale get|set|list".into()),
    }
}
