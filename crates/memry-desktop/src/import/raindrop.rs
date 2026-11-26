//! The Raindrop importer: `apps/desktop/src/main/import/raindrop/raindrop-importer.ts` and
//! `packages/importers/src/raindrop/{parse-csv,map-rows}.ts`.
//!
//! Each row of a picked Raindrop.io CSV export becomes a `link` inbox item
//! ([`ImportSink::save_bookmark`]); a row without a URL is skipped. Raindrop's CSV dialect is not
//! the CSV importer's: a CR outside quotes is dropped instead of ending a row, a column is found
//! by its first header, and a row is dropped only when every cell is empty, not blank.
//!
//! Electron parsed every file into a plan and held them all before it saved the first bookmark,
//! with no bound: a two-byte row became an item of several hundred bytes. Here the reader keeps
//! only Raindrop's columns, and the plans of one run share a [`MAX_PLANNED_BYTES`] budget. A
//! file past it fails before any of its bookmarks is saved, and the other files still import.

use std::collections::HashSet;
use std::path::Path;

use memry_core::markdown::frontmatter::js_trim;
use tokio_util::sync::CancellationToken;

use super::csv_lex::{lex, step};
use super::messages::{ImportMessage, ImportText, codes, status};
use super::{
    BookmarkMetadata, FileSpec, ImportContext, ImportError, ImportInput, ImportPhase,
    ImportPreview, ImportSink, ImportedBookmark, Importer, ImporterMeta, MAX_PLANNED_BYTES,
    PreviewCount, PreviewGroup, base_name, read_source_text,
};
use crate::web::extract::utils::date::parse_date;

/// What a planned bookmark costs besides the text it stores: the struct, its strings' headers
/// and the allocator's overhead.
const ITEM_COST: usize = 1024;
/// What one tag costs besides its text.
const TAG_COST: usize = 48;
/// What a skipped row costs: its number, and the warning the preview renders from it.
const WARNING_COST: usize = 256;
// The budget holds 300,000 bookmarks of 300 bytes of text, stored twice, and three tags each.
const _: () = assert!(MAX_PLANNED_BYTES / (ITEM_COST + 2 * 300 + 3 * TAG_COST) >= 300_000);
const SAMPLE_MAX: usize = 5;
const UNSORTED: &str = "unsorted";
const TOO_MANY: &str = "The picked Raindrop files hold more bookmarks than one import can take. \
                        Import fewer files at a time, or split the export into smaller files.";

/// The columns `parseRaindropCsv` reads, in `RaindropRow` order.
const COLUMNS: [&str; 11] = [
    "id",
    "title",
    "note",
    "excerpt",
    "url",
    "folder",
    "tags",
    "created",
    "cover",
    "highlights",
    "favorite",
];
const TITLE: usize = 1;
const NOTE: usize = 2;
const EXCERPT: usize = 3;
const URL: usize = 4;
const FOLDER: usize = 5;
const TAGS: usize = 6;
const CREATED: usize = 7;
const COVER: usize = 8;
const HIGHLIGHTS: usize = 9;
const FAVORITE: usize = 10;

/// `RaindropImportPlan`, with each skipped row kept as its number.
#[derive(Default)]
struct Plan {
    items: Vec<ImportedBookmark>,
    skipped_rows: Vec<usize>,
}

/// The warning of a row without a URL; `row` counts the rows with a cell from 1.
fn no_url(row: usize) -> ImportMessage {
    ImportMessage::coded(
        codes::RAINDROP_ROW_NO_URL,
        format!("Row {row} skipped: no URL"),
    )
    .with_param("row", row)
}

/// `parseRaindropCsv` and `mapRows` in one pass over the export.
struct Reader<'b> {
    /// Each column's first index; `None` until the header row ended.
    columns: Option<[Option<usize>; 11]>,
    header: [Option<usize>; 11],
    at: usize,
    cells: [String; 11],
    any_cell: bool,
    rows: usize,
    plan: Plan,
    budget: &'b mut usize,
    too_large: bool,
}

impl Reader<'_> {
    fn field(&mut self, text: &str) {
        match &self.columns {
            None => {
                let name = js_trim(text);
                if let Some(column) = COLUMNS.iter().position(|c| *c == name) {
                    self.header[column].get_or_insert(self.at);
                }
            }
            Some(columns) => {
                self.any_cell |= !text.is_empty();
                if let Some(column) = columns.iter().position(|c| *c == Some(self.at)) {
                    text.clone_into(&mut self.cells[column]);
                }
            }
        }
        self.at += 1;
    }

    /// Ends a row; false when the header has no `url` column or the plan is past the budget.
    fn row_end(&mut self) -> bool {
        self.at = 0;
        if self.columns.is_none() {
            self.columns = Some(self.header);
            return self.header[URL].is_some();
        }
        let cells = std::mem::take(&mut self.cells);
        if std::mem::take(&mut self.any_cell) {
            self.rows += 1;
            self.map_row(cells);
        }
        !self.too_large
    }

    fn charge(&mut self, cost: usize) -> bool {
        match self.budget.checked_sub(cost) {
            Some(left) => *self.budget = left,
            None => self.too_large = true,
        }
        !self.too_large
    }

    fn map_row(&mut self, cells: [String; 11]) {
        let url = js_trim(&cells[URL]);
        if url.is_empty() {
            if self.charge(WARNING_COST) {
                self.plan.skipped_rows.push(self.rows);
            }
            return;
        }
        let created = js_trim(&cells[CREATED]);
        let item = ImportedBookmark {
            title: match js_trim(&cells[TITLE]) {
                "" => url.to_owned(),
                title => title.to_owned(),
            },
            content: content(&cells[NOTE], &cells[EXCERPT]),
            source_url: url.to_owned(),
            created_at: is_iso_instant(created).then(|| created.to_owned()),
            tags: resolve_tags(&split_tags(&cells[TAGS]), &cells[FOLDER]),
            metadata: BookmarkMetadata {
                url: url.to_owned(),
                excerpt: js_trim(&cells[EXCERPT]).to_owned(),
                note: js_trim(&cells[NOTE]).to_owned(),
                folder: js_trim(&cells[FOLDER]).to_owned(),
                favorite: js_trim(&cells[FAVORITE]).to_lowercase() == "true",
                hero_image: js_trim(&cells[COVER]).to_owned(),
                highlights: js_trim(&cells[HIGHLIGHTS]).to_owned(),
            },
        };
        if self.charge(stored_cost(&item)) {
            self.plan.items.push(item);
        }
    }
}

/// What `item` holds, counting its text once for each place it is stored: an empty title's URL
/// is the title, the source URL and the metadata's, and a tag counts as lowercased.
fn stored_cost(item: &ImportedBookmark) -> usize {
    let meta = &item.metadata;
    let text = item.title.len()
        + item.content.as_deref().map_or(0, str::len)
        + item.source_url.len()
        + item.created_at.as_deref().map_or(0, str::len)
        + meta.url.len()
        + meta.excerpt.len()
        + meta.note.len()
        + meta.folder.len()
        + meta.hero_image.len()
        + meta.highlights.len();
    let tags: usize = item.tags.iter().map(|tag| TAG_COST + tag.len()).sum();
    ITEM_COST + text + tags
}

/// `splitTags`: comma-separated, trimmed and lowercased.
fn split_tags(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|tag| {
            step();
            js_trim(tag).to_lowercase()
        })
        .filter(|tag| !tag.is_empty())
        .collect()
}

/// `resolveTags`: the row's tags, then its collection unless it is `Unsorted`, first spelling
/// of each case-insensitive name kept.
fn resolve_tags(tags: &[String], folder: &str) -> Vec<String> {
    let folder = js_trim(folder);
    let from_folder = (!folder.is_empty() && folder.to_lowercase() != UNSORTED).then_some(folder);
    let mut seen = HashSet::new();
    tags.iter()
        .map(String::as_str)
        .chain(from_folder)
        .map(js_trim)
        .filter(|tag| !tag.is_empty() && seen.insert(tag.to_lowercase()))
        .map(str::to_owned)
        .collect()
}

/// `resolveContent`: note and excerpt joined; `None` when both are blank.
fn content(note: &str, excerpt: &str) -> Option<String> {
    let parts: Vec<&str> = [note, excerpt]
        .into_iter()
        .map(js_trim)
        .filter(|part| !part.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// `resolveCreatedAt`'s test: `^\d{4}-\d{2}-\d{2}T` and a date `Date.parse` reads.
fn is_iso_instant(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() > 10
        && bytes[..10].iter().enumerate().all(|(at, b)| match at {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
        && bytes[10] == b'T'
        && parse_date(text).is_some()
}

/// Reads and plans one file, charging `budget` only when the whole file fits.
fn plan_file(path: &Path, budget: &mut usize) -> Result<Plan, ImportMessage> {
    let text = read_source_text(path).map_err(|error| ImportMessage {
        code: None,
        message: error.to_string(),
        params: None,
    })?;
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    let mut left = *budget;
    let mut reader = Reader {
        columns: None,
        header: [None; 11],
        at: 0,
        cells: Default::default(),
        any_cell: false,
        rows: 0,
        plan: Plan::default(),
        budget: &mut left,
        too_large: false,
    };
    let mut lexed_any = false;
    lex(text, |event| {
        lexed_any = true;
        match event {
            Some(field) => {
                reader.field(field);
                true
            }
            None => reader.row_end(),
        }
    });
    if !lexed_any {
        return Err(ImportMessage::coded(
            codes::RAINDROP_CSV_EMPTY,
            "Raindrop CSV is empty",
        ));
    }
    if reader.too_large {
        return Err(ImportMessage {
            code: None,
            message: TOO_MANY.to_owned(),
            params: None,
        });
    }
    if reader.columns.is_none_or(|columns| columns[URL].is_none()) {
        return Err(ImportMessage::coded(
            codes::RAINDROP_HEADER_NOT_FOUND,
            "Raindrop CSV header row (\"url\" column) not found",
        ));
    }
    let plan = reader.plan;
    *budget = left;
    Ok(plan)
}

pub struct RaindropImporter {
    /// The run's [`MAX_PLANNED_BYTES`]; tests lower it.
    pub budget: usize,
}

impl Default for RaindropImporter {
    fn default() -> Self {
        Self {
            budget: MAX_PLANNED_BYTES,
        }
    }
}

impl Importer for RaindropImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "raindrop".to_owned(),
            name: "Raindrop".to_owned(),
            description_key: "import.sources.raindrop".to_owned(),
            file_spec: FileSpec {
                label: "Raindrop CSV export".to_owned(),
                extensions: vec!["csv".to_owned()],
                allow_multiple: true,
                ..FileSpec::default()
            },
            supports_preview: true,
            account_based: false,
        }
    }

    /// `buildRaindropPreview`.
    fn preview(
        &self,
        input: &ImportInput,
        cancel: &CancellationToken,
    ) -> Result<ImportPreview, ImportError> {
        let mut budget = self.budget;
        let mut groups = Vec::new();
        for source in &input.source_paths {
            if cancel.is_cancelled() {
                break;
            }
            let path = Path::new(source);
            let label = base_name(path);
            groups.push(match plan_file(path, &mut budget) {
                Ok(plan) => PreviewGroup {
                    label,
                    counts: vec![
                        count("import.stats.bookmarks", plan.items.len()),
                        count(
                            "import.stats.withTags",
                            plan.items.iter().filter(|i| !i.tags.is_empty()).count(),
                        ),
                        count("import.stats.skipped", plan.skipped_rows.len()),
                    ],
                    sample_titles: Some(
                        plan.items
                            .iter()
                            .take(SAMPLE_MAX)
                            .map(|item| item.title.clone())
                            .collect(),
                    ),
                    warnings: Some(
                        plan.skipped_rows
                            .iter()
                            .map(|row| ImportText::Message(no_url(*row)))
                            .collect(),
                    ),
                    error: None,
                },
                Err(error) => PreviewGroup {
                    label,
                    counts: Vec::new(),
                    sample_titles: None,
                    warnings: None,
                    error: Some(ImportText::Message(error)),
                },
            });
        }
        Ok(ImportPreview { groups })
    }

    /// `raindropImporter.run` and `runRaindropImport`.
    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), ImportError> {
        ctx.set_phase(ImportPhase::Importing);
        ctx.status(status("raindropImporting"));

        let mut budget = self.budget;
        let plans: Vec<(String, Result<Plan, ImportMessage>)> = input
            .source_paths
            .iter()
            .map(|source| {
                let path = Path::new(source);
                (base_name(path), plan_file(path, &mut budget))
            })
            .collect();
        let total = plans
            .iter()
            .map(|(_, plan)| plan.as_ref().map_or(0, |plan| plan.items.len()))
            .sum();
        let mut done = 0;
        ctx.report_progress(0, total);

        for (file_name, plan) in plans {
            if ctx.is_cancelled() {
                return Ok(());
            }
            let plan = match plan {
                Ok(plan) => plan,
                Err(error) => {
                    tracing::error!(scope = "import", "Raindrop import failed for a file");
                    ctx.report_failed(&file_name, &error.message);
                    continue;
                }
            };
            for row in plan.skipped_rows {
                ctx.report_skipped(&no_url(row).message, None);
            }
            for item in plan.items {
                if ctx.is_cancelled() {
                    return Ok(());
                }
                let title = item.title.clone();
                match sink.save_bookmark(item) {
                    Ok(()) => ctx.report_imported(),
                    Err(error) => {
                        tracing::warn!(scope = "import", "Raindrop bookmark import failed");
                        ctx.report_failed(&title, &error.0);
                    }
                }
                done += 1;
                ctx.report_progress(done, total);
            }
        }
        Ok(())
    }
}

fn count(label_key: &str, value: usize) -> PreviewCount {
    PreviewCount {
        label_key: label_key.to_owned(),
        value,
    }
}
