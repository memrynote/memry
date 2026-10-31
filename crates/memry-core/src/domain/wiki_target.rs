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
//!
//! A lookup reads only the rows that can answer it ([`WikiNames::load_for`]):
//! `wiki_name_keys` holds every key each live note and day claims, computed here
//! because SQLite's `lower()` folds ASCII only. Triggers on `notes`,
//! `journal_entries` and `journal_aliases` list a changed id in
//! `wiki_names_owed` (data migration 0019), so a row written by any writer, an
//! older build's included, is read whole until [`settle_name_keys`] stores its
//! keys again. A lookup is answered from every row claiming one of its keys plus
//! every owed row, and the tie-break needs only the rows claiming a key, so the
//! answer is the one [`WikiNames::load`] gives.

use std::collections::{HashMap, HashSet};

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

/// The ids that claim one of the keys in `?1` (a JSON array), and every owed id.
pub(crate) const CANDIDATES: &str = "SELECT id FROM wiki_name_keys \
     WHERE key IN (SELECT value FROM json_each(?1)) UNION SELECT id FROM wiki_names_owed";

impl WikiNames {
    /// Every live note and day: the whole vault's names, for a pass over many targets.
    pub fn load(conn: &Connection) -> Result<Self, StorageError> {
        Ok(Self::ranked(rows(conn, None)?))
    }

    /// The rows that can answer `targets`, each a whole wiki-link target or a bare
    /// title: those whose stored keys hold one of the targets' keys, and every row
    /// owed new keys. Resolving any of `targets` gives what [`WikiNames::load`]
    /// gives; reads grow with the matches and the owed rows, not with the vault.
    pub fn load_for<'a>(
        conn: &Connection,
        targets: impl IntoIterator<Item = &'a str>,
    ) -> Result<Self, StorageError> {
        let keys: HashSet<String> = targets.into_iter().flat_map(target_keys).collect();
        let keys = to_json(&keys)?;
        let mut statement = conn.prepare(CANDIDATES).map_err(failed)?;
        let ids = statement
            .query_map([keys], |row| row.get::<_, String>(0))
            .map_err(failed)?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(failed)?;
        Ok(Self::ranked(rows(conn, Some(&to_json(&ids)?))?))
    }

    /// Builds the index with its tie-break: notes before journal days, then
    /// by id. Every lookup map keeps the first row that claims a key, so this
    /// order decides which row a shared name resolves to.
    fn ranked(mut rows: Vec<Row>) -> Self {
        rows.sort_by(|a, b| {
            (a.journal_date.is_some(), &a.id).cmp(&(b.journal_date.is_some(), &b.id))
        });
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
            let claims = Claims::of(&row);
            if let Some(path) = claims.path {
                names.by_path.entry(path).or_insert(at);
            }
            if let Some(file) = claims.file {
                names.by_file.entry(file).or_insert(at);
            }
            names.by_title.entry(claims.title).or_insert(at);
            if let Some(key) = claims.title_key {
                names.by_title_key.entry(key).or_insert(at);
            }
            for key in claims.alias_keys {
                names.by_alias_key.entry(key).or_insert(at);
            }
            if let Some(date) = &row.journal_date {
                names.by_date.entry(date.clone()).or_insert(at);
            }
            names.by_id.entry(row.id.clone()).or_insert(at);
            let (link_keys, link_prefixes) = link_forms(&row);
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

/// The keys one row claims in [`WikiNames`]'s lookup maps, one field per map.
struct Claims {
    /// `by_path`: a markdown note's folded `folder/Title.md`.
    path: Option<String>,
    /// `by_file`: an attachment's folded `folder/Title`.
    file: Option<String>,
    /// `by_title`: the title as written (a day's date).
    title: String,
    title_key: Option<String>,
    alias_keys: Vec<String>,
}

impl Claims {
    fn of(row: &Row) -> Self {
        let (path, file) = match &row.stem {
            Some((stem, true)) => (Some(fold(&format!("{stem}.md"))), None),
            Some((stem, false)) => (None, Some(fold(stem))),
            None => (None, None),
        };
        Self {
            path,
            file,
            title: row.title.clone(),
            title_key: name_key(&row.title),
            alias_keys: row
                .aliases
                .iter()
                .filter_map(|alias| name_key(alias))
                .collect(),
        }
    }

    /// Every claim, as `wiki_name_keys` stores them. A day's date is its title.
    fn all(self) -> impl Iterator<Item = String> {
        self.path
            .into_iter()
            .chain(self.file)
            .chain([self.title])
            .chain(self.title_key)
            .chain(self.alias_keys)
    }
}

/// The `note_links.target_key` forms that link to the row (`link_keys`), and the prefixes
/// of an attachment's forms with any extension.
fn link_forms(row: &Row) -> (Vec<String>, Vec<String>) {
    let mut link_keys = Vec::new();
    let mut link_prefixes = Vec::new();
    if let Some((stem, markdown)) = &row.stem
        && let Some(key) = name_key(stem)
    {
        if *markdown {
            link_keys.extend([format!("{key}.md"), format!("/{key}"), format!("/{key}.md")]);
        } else {
            link_prefixes.extend([format!("{key}."), format!("/{key}.")]);
        }
        link_keys.push(key);
    }
    link_keys.extend(name_key(&row.title));
    link_keys.extend(row.aliases.iter().filter_map(|alias| name_key(alias)));
    if let Some(date) = &row.journal_date {
        link_keys.push(format!("j{date}"));
    }
    (link_keys, link_prefixes)
}

/// Every key a lookup of `half` reads in [`WikiNames::resolve`]: the path forms of a half
/// with a `/`, the title as written, and its name key.
fn half_keys(half: &str) -> Vec<String> {
    let written = js_trim(half);
    let mut keys = vec![written.to_owned()];
    if written.contains('/') {
        let stem = written.strip_prefix('/').unwrap_or(written);
        let folded = fold(stem);
        keys.push(fold(&format!("{stem}.md")));
        if let Some((bare, _)) = folded.rsplit_once('.') {
            keys.push(bare.to_owned());
        }
        keys.push(folded);
    }
    keys.extend(name_key(half));
    keys
}

/// Every key resolving `target` reads: [`WikiNames::resolve_target`]'s note half and whole
/// target, and the day a date or `j<date>` names ([`WikiNames::journal_on`]).
fn target_keys(target: &str) -> Vec<String> {
    let raw = target.trim();
    let mut keys = half_keys(raw);
    keys.extend(half_keys(split(raw).0));
    if let Some((date, _)) = crate::domain::note_meta::journal_date_of(raw) {
        keys.push(date);
    }
    keys
}

/// Stores the keys of every id `wiki_names_owed` lists and clears the list: an id no longer
/// live keeps no key. On `data.db`'s writer, in one transaction. The number of ids settled.
pub fn settle_name_keys(conn: &Connection) -> Result<usize, StorageError> {
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let ids = {
        let mut statement = transaction
            .prepare("SELECT DISTINCT id FROM wiki_names_owed")
            .map_err(failed)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(failed)?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(failed)?
    };
    if ids.is_empty() {
        return Ok(0);
    }
    let list = to_json(&ids)?;
    transaction
        .execute(
            "DELETE FROM wiki_name_keys WHERE id IN (SELECT value FROM json_each(?1))",
            [&list],
        )
        .map_err(failed)?;
    {
        let mut insert = transaction
            .prepare("INSERT OR IGNORE INTO wiki_name_keys (key, id) VALUES (?1, ?2)")
            .map_err(failed)?;
        for row in rows(&transaction, Some(&list))? {
            for key in Claims::of(&row).all() {
                insert.execute([&key, &row.id]).map_err(failed)?;
            }
        }
    }
    transaction
        .execute(
            "DELETE FROM wiki_names_owed WHERE id IN (SELECT value FROM json_each(?1))",
            [&list],
        )
        .map_err(failed)?;
    transaction.commit().map_err(failed)?;
    Ok(ids.len())
}

/// The live notes and days, all of them or those whose id `ids` (a JSON array) lists.
fn rows(conn: &Connection, ids: Option<&str>) -> Result<Vec<Row>, StorageError> {
    let only = if ids.is_some() {
        " AND id IN (SELECT value FROM json_each(?1))"
    } else {
        ""
    };
    let mut rows = Vec::new();
    let mut notes = conn
        .prepare(&format!(
            "SELECT id, title, folder_path, file_type, aliases FROM notes \
             WHERE deleted_at IS NULL{only}"
        ))
        .map_err(failed)?;
    let found = notes
        .query_map(rusqlite::params_from_iter(ids), |row| {
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
    let only = only.replace("id IN", "j.id IN");
    let mut days = conn
        .prepare(&format!(
            "SELECT j.id, j.date, a.aliases FROM journal_entries j \
             LEFT JOIN journal_aliases a ON a.journal_id = j.id \
             WHERE j.deleted_at IS NULL{only}"
        ))
        .map_err(failed)?;
    let found = days
        .query_map(rusqlite::params_from_iter(ids), |row| {
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
    Ok(rows)
}

fn to_json(ids: &HashSet<String>) -> Result<String, StorageError> {
    serde_json::to_string(ids).map_err(|error| StorageError::Failed {
        what: format!("keys will not serialise: {error}"),
    })
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
