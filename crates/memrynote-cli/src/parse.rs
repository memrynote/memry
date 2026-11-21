//! The grammar of `parseCli` (`apps/cli/src/cli-support.ts:62-101`).

/// One parsed command line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedCli {
    pub vault_path: Option<String>,
    pub json: bool,
    pub command: Option<String>,
    pub subcommand: Option<String>,
    pub positionals: Vec<String>,
    pub flags: Flags,
}

/// The flags in first-seen order, each with every value it was given.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Flags(Vec<(String, Vec<String>)>);

impl Flags {
    pub fn has(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }

    /// Every value of `key`, in order (`getFlagList`).
    pub fn list(&self, key: &str) -> &[String] {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map_or(&[], |(_, values)| values.as_slice())
    }

    /// The last value of `key` (`getFlag`).
    pub fn get(&self, key: &str) -> Option<&str> {
        self.list(key).last().map(String::as_str)
    }

    fn push(&mut self, key: String, value: String) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some((_, values)) => values.push(value),
            None => self.0.push((key, vec![value])),
        }
    }
}

/// `--vault` takes the next token wherever it appears and `--json` is dropped; the first two
/// remaining tokens are the command and subcommand. A `--flag` takes the next token unless it
/// is missing, empty or starts with `--`, and is `true` otherwise. When the next token is the
/// word `true`, the TypeScript compares the value and not the token, so the word is also kept
/// as a positional; that quirk is part of the contract.
pub fn parse_cli(args: &[String]) -> ParsedCli {
    let mut globals = Vec::new();
    let mut vault_path = None;
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--vault" => {
                vault_path = args.get(index + 1).cloned();
                index += 1;
            }
            "--json" => json = true,
            _ => globals.push(args[index].clone()),
        }
        index += 1;
    }

    let mut rest = globals.into_iter();
    let command = rest.next();
    let subcommand = rest.next();
    let rest: Vec<String> = rest.collect();
    let mut positionals = Vec::new();
    let mut flags = Flags::default();
    let mut index = 0;
    while index < rest.len() {
        let arg = &rest[index];
        let Some(key) = arg.strip_prefix("--") else {
            positionals.push(arg.clone());
            index += 1;
            continue;
        };
        let value = match rest.get(index + 1) {
            Some(next) if !next.is_empty() && !next.starts_with("--") => next.clone(),
            _ => "true".to_owned(),
        };
        if value != "true" {
            index += 1;
        }
        flags.push(key.to_owned(), value);
        index += 1;
    }

    ParsedCli {
        vault_path,
        json,
        command,
        subcommand,
        positionals,
        flags,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> ParsedCli {
        parse_cli(&args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn vault_and_json_are_taken_wherever_they_appear() {
        let parsed = parse(&["notes", "--vault", "/v", "list", "--json", "--limit", "5"]);
        assert_eq!(parsed.vault_path.as_deref(), Some("/v"));
        assert!(parsed.json);
        assert_eq!(parsed.command.as_deref(), Some("notes"));
        assert_eq!(parsed.subcommand.as_deref(), Some("list"));
        assert_eq!(parsed.flags.get("limit"), Some("5"));
        assert!(parsed.positionals.is_empty());
    }

    #[test]
    fn a_trailing_vault_flag_has_no_path() {
        let parsed = parse(&["vault", "current", "--vault"]);
        assert_eq!(parsed.vault_path, None);
        assert_eq!(parsed.subcommand.as_deref(), Some("current"));
    }

    #[test]
    fn the_word_true_after_a_flag_is_also_a_positional() {
        let parsed = parse(&["tasks", "update", "--done", "true", "id-1"]);
        assert_eq!(parsed.flags.list("done"), ["true"]);
        assert_eq!(parsed.positionals, ["true", "id-1"]);
    }

    #[test]
    fn a_flag_before_another_flag_or_an_empty_token_is_true() {
        let parsed = parse(&["notes", "list", "--a", "--b", "", "--c"]);
        assert_eq!(parsed.flags.get("a"), Some("true"));
        assert_eq!(parsed.flags.get("b"), Some("true"));
        assert_eq!(parsed.flags.get("c"), Some("true"));
        assert_eq!(parsed.positionals, [""]);
    }

    #[test]
    fn repeated_flags_accumulate_and_the_last_one_wins_a_get() {
        let parsed = parse(&[
            "notes", "create", "T", "--tag", "a", "--x", "1", "--tag", "b",
        ]);
        assert_eq!(parsed.flags.list("tag"), ["a", "b"]);
        assert_eq!(parsed.flags.get("tag"), Some("b"));
        assert_eq!(parsed.flags.list("missing"), [] as [String; 0]);
        assert_eq!(parsed.positionals, ["T"]);
    }

    #[test]
    fn a_vault_value_is_not_a_command() {
        let parsed = parse(&["--vault", "notes", "--json"]);
        assert_eq!(parsed.vault_path.as_deref(), Some("notes"));
        assert_eq!(parsed.command, None);
    }
}
