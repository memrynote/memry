//! Reading a `[[wiki link]]` target: its note and heading halves, and the note
//! or journal day a note half names.
//!
//! Desktop's `packages/shared/src/wiki-target.ts` and `note-names.ts` are the
//! reference, pinned by the `wiki-target-resolution` vectors (chapter 12
//! §12.3). The rules that shape everything here:
//!
//!   * `Note#Heading` addresses a heading inside `Note`, but `#` is legal in a
//!     title (`Sprint #4`), so a caller resolves the split half first and falls
//!     back to the raw string ([`split`], [`WikiNames::resolve_target`]).
//!   * A title is a file's basename and never holds `/`, so a note half with a
//!     `/` is a path from the vault root (`Folder/Note`), matched with the tag
//!     fold against the note's vault-relative path with or without `.md`. A
//!     path that matches nothing falls back to the names.
//!   * Then a title spelled exactly as written, then a title with the same
//!     [`name_key`], then an alias with the same key: a title always beats an
//!     alias. A journal day is titled with its date, as desktop titles it.
//!   * Two candidates in one tier: a note before a journal day, then the lowest
//!     id, so two runs answer the same note.
//!
//! The core has no `path` column: a note sits at `folder_path` and its file is
//! named after its title, `Title.md` for markdown and `Title.<ext>` for an
//! attachment, whose title desktop takes from the filename without its
//! extension (`indexer.ts`). The extension itself is not projected, so a path
//! link to an attachment matches on any extension.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::notes::names::{js_trim, name_key, parse_stored};
use crate::domain::tags::fold;

/// A target's note half, and its heading half when it carries a `#`.
///
/// `Note#H1#H2` names the last heading, like desktop's `splitWikiTarget`.
pub fn split(target: &str) -> (&str, Option<&str>) {
    let raw = target.trim();
    match raw.split_once('#') {
        None => (raw, None),
        Some((note, rest)) => (note.trim(), rest.rsplit('#').next().map(str::trim)),
    }
}

/// The vault-relative stem a path-form note half names, or `None` for a
/// title. One leading `/` is tolerated.
pub fn path_stem(note_half: &str) -> Option<&str> {
    let half = note_half.trim();
    half.contains('/')
        .then(|| half.strip_prefix('/').unwrap_or(half))
}

/// The lowercased `note_links.target_title` forms a path-form link to a
/// markdown note can be stored under: `Folder/Note` and `Folder/Note.md`, each
/// with or without a leading `/`. Desktop's `pathLinkKeys`. A root note's
/// path form is `/Note`.
pub fn path_link_keys(folder_path: Option<&str>, title: &str) -> Vec<String> {
    let stem = match folder_path.filter(|folder| !folder.is_empty()) {
        Some(folder) => format!("{folder}/{title}"),
        None => title.to_owned(),
    }
    .to_lowercase();
    let mut keys = vec![format!("/{stem}"), format!("/{stem}.md")];
    if stem.contains('/') {
        keys.extend([stem.clone(), format!("{stem}.md")]);
    }
    keys
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchedBy {
    Path,
    Title,
    Alias,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiMatch {
    pub id: String,
    pub journal_date: Option<String>,
    pub matched_by: MatchedBy,
}

pub fn resolve(conn: &Connection, half: &str) -> Result<Option<WikiMatch>, StorageError> {
    Ok(WikiNames::load(conn)?.resolve(half))
}

pub struct WikiNames {
    entries: Vec<Entry>,
    by_id: HashMap<String, usize>,
    by_path: HashMap<String, usize>,
    by_file: HashMap<String, usize>,
    by_title: HashMap<String, usize>,
    by_title_key: HashMap<String, usize>,
    by_alias_key: HashMap<String, usize>,
    by_date: HashMap<String, usize>,
}

struct Entry {
    id: String,
    journal_date: Option<String>,
    link_keys: Vec<String>,
    link_prefixes: Vec<String>,
}

struct Row {
    id: String,
    title: String,
    stem: Option<(String, bool)>,
    journal_date: Option<String>,
    aliases: Vec<String>,
}

impl WikiNames {
    pub fn load(conn: &Connection) -> Result<Self, StorageError> {
        let mut rows = Vec::new();
        let mut notes = conn
            .prepare(
                "SELECT id, title, folder_path, file_type, aliases FROM notes \
                 WHERE deleted_at IS NULL",
            )
            .map_err(failed)?;
        let found = notes
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(failed)?;
        for row in found {
            let (id, title, folder, file_type, aliases) = row.map_err(failed)?;
            let stem = match folder.filter(|folder| !folder.is_empty()) {
                Some(folder) => format!("{folder}/{title}"),
                None => title.clone(),
            };
            rows.push(Row {
                aliases: parse_aliases(&id, aliases)?,
                id,
                title,
                stem: Some((stem, file_type == "markdown")),
                journal_date: None,
            });
        }
        let mut days = conn
            .prepare(
                "SELECT j.id, j.date, a.aliases FROM journal_entries j \
                 LEFT JOIN journal_aliases a ON a.journal_id = j.id \
                 WHERE j.deleted_at IS NULL",
            )
            .map_err(failed)?;
        let found = days
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(failed)?;
        for row in found {
            let (id, date, aliases) = row.map_err(failed)?;
            rows.push(Row {
                aliases: parse_aliases(&id, aliases)?,
                id,
                title: date.clone(),
                stem: None,
                journal_date: Some(date),
            });
        }
        rows.sort_by(|a, b| {
            (a.journal_date.is_some(), &a.id).cmp(&(b.journal_date.is_some(), &b.id))
        });
        Ok(Self::from_rows(rows))
    }

    fn from_rows(rows: Vec<Row>) -> Self {
        let mut names = Self {
            entries: Vec::with_capacity(rows.len()),
            by_id: HashMap::new(),
            by_path: HashMap::new(),
            by_file: HashMap::new(),
            by_title: HashMap::new(),
            by_title_key: HashMap::new(),
            by_alias_key: HashMap::new(),
            by_date: HashMap::new(),
        };
        for (at, row) in rows.into_iter().enumerate() {
            let mut link_keys = Vec::new();
            let mut link_prefixes = Vec::new();
            if let Some((stem, markdown)) = &row.stem {
                let map = if *markdown {
                    names.by_path.entry(fold(&format!("{stem}.md")))
                } else {
                    names.by_file.entry(fold(stem))
                };
                map.or_insert(at);
                if let Some(key) = name_key(stem) {
                    if *markdown {
                        link_keys.extend([
                            format!("{key}.md"),
                            format!("/{key}"),
                            format!("/{key}.md"),
                        ]);
                    } else {
                        link_prefixes.extend([format!("{key}."), format!("/{key}.")]);
                    }
                    link_keys.push(key);
                }
            }
            names.by_title.entry(row.title.clone()).or_insert(at);
            if let Some(key) = name_key(&row.title) {
                names.by_title_key.entry(key.clone()).or_insert(at);
                link_keys.push(key);
            }
            for alias in &row.aliases {
                if let Some(key) = name_key(alias) {
                    names.by_alias_key.entry(key.clone()).or_insert(at);
                    link_keys.push(key);
                }
            }
            if let Some(date) = &row.journal_date {
                names.by_date.entry(date.clone()).or_insert(at);
                link_keys.push(format!("j{date}"));
            }
            names.by_id.entry(row.id.clone()).or_insert(at);
            names.entries.push(Entry {
                id: row.id,
                journal_date: row.journal_date,
                link_keys,
                link_prefixes,
            });
        }
        names
    }

    pub fn resolve(&self, half: &str) -> Option<WikiMatch> {
        let written = js_trim(half);
        if written.contains('/') {
            let stem = written.strip_prefix('/').unwrap_or(written);
            if let Some(at) = self.by_path(stem) {
                return Some(self.matched(at, MatchedBy::Path));
            }
        }
        let key = name_key(half)?;
        if let Some(&at) = self
            .by_title
            .get(written)
            .or_else(|| self.by_title_key.get(&key))
        {
            return Some(self.matched(at, MatchedBy::Title));
        }
        let &at = self.by_alias_key.get(&key)?;
        Some(self.matched(at, MatchedBy::Alias))
    }

    /// What a whole target names and the heading to scroll to: the split note
    /// half first, then the raw string, where any `#` belongs to the title and
    /// there is no heading. A `#^block` reference opens the target with no
    /// heading. `None` is a broken link, and also `[[#Heading]]`, which the
    /// caller that knows the current note answers.
    pub fn resolve_target(&self, target: &str) -> Option<(WikiMatch, Option<String>)> {
        let raw = target.trim();
        if raw.is_empty() {
            return None;
        }
        let (note, heading) = split(raw);
        if let Some(heading) = heading {
            if note.is_empty() {
                return None;
            }
            if let Some(found) = self.resolve(note) {
                let anchor =
                    (!heading.is_empty() && !heading.starts_with('^')).then(|| heading.to_owned());
                return Some((found, anchor));
            }
        }
        self.resolve(raw).map(|found| (found, None))
    }

    pub fn journal_on(&self, date: &str) -> Option<&str> {
        self.by_date
            .get(date)
            .map(|&at| self.entries[at].id.as_str())
    }

    pub fn link_keys(&self, id: &str) -> (&[String], &[String]) {
        match self.by_id.get(id) {
            Some(&at) => (&self.entries[at].link_keys, &self.entries[at].link_prefixes),
            None => (&[], &[]),
        }
    }

    fn by_path(&self, stem: &str) -> Option<usize> {
        let folded = fold(stem);
        let markdown = [folded.clone(), fold(&format!("{stem}.md"))]
            .into_iter()
            .filter_map(|path| self.by_path.get(&path).copied());
        let file = folded
            .rsplit_once('.')
            .filter(|(bare, ext)| {
                !bare.is_empty() && !bare.ends_with('/') && !ext.contains('/') && *ext != "md"
            })
            .and_then(|(bare, _)| self.by_file.get(bare).copied());
        markdown.chain(file).min()
    }

    fn matched(&self, at: usize, matched_by: MatchedBy) -> WikiMatch {
        let entry = &self.entries[at];
        WikiMatch {
            id: entry.id.clone(),
            journal_date: entry.journal_date.clone(),
            matched_by,
        }
    }
}

fn parse_aliases(id: &str, raw: Option<String>) -> Result<Vec<String>, StorageError> {
    parse_stored(raw).map_err(|error| StorageError::Failed {
        what: format!("`{id}` has unreadable `aliases`: {error}"),
    })
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
