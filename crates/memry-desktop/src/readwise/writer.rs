//! The one write path from a Readwise book into the vault (`note-writer.ts`, D5, D6). Never
//! rewrites text the user may have touched, never writes frontmatter after creation (D4), and
//! writes nothing when the bytes would not change. A failure never stops a run: the book goes
//! on the retry list and the outcome says why.

use chrono_tz::Tz;
use memry_core::domain::readwise::{LinkKey, LinkState, ReadwiseItem, parse_readwise_url};
use serde_json::{Map, Value};

use super::highlights::{image_highlight_url, linked_highlight_ids};
use super::images::resolve_images;
use super::library::Library;
use super::plan_append::{PlanAppendOptions, plan_append};
use super::plan_note::{BookPlan, NotePlan, PlanNoteOptions, plan_note};
use super::run_state::RunState;
use super::section::{
    EndMarker, SectionProblem, SectionRead, hash_section_body, read_section, write_end_marker,
};
use super::steps;
use super::types::{CategorySwitches, FolderLayout, FrontmatterValue, ReadwiseBook, SavedImages};
use crate::notes::create::NewNoteFile;
use crate::notes::update::NoteUpdateInput;
use crate::notes::view::NoteView;
use crate::web::extract::utils::date::iso_string;
use crate::web::extract::utils::js::is_js_whitespace;

const SCOPE: &str = "ReadwiseWriter";

/// `PlanNoteOptions` without the images, which each write resolves.
#[derive(Debug, Clone)]
pub struct PlanBase {
    pub root: String,
    pub folder_layout: FolderLayout,
    pub categories: CategorySwitches,
    pub time_zone: Tz,
}

impl PlanBase {
    pub fn plan(&self, book: &ReadwiseBook, images: &SavedImages) -> Result<BookPlan, String> {
        let options = PlanNoteOptions {
            root: &self.root,
            folder_layout: self.folder_layout,
            categories: self.categories,
            time_zone: self.time_zone,
            images,
        };
        plan_note(book, &options).map_err(|error| error.to_string())
    }
}

/// `UpsertOptions` without `planOptions`.
#[derive(Debug, Clone, Copy, Default)]
pub struct UpsertOptions {
    /// Re-import (D16): rewrite the section from the full book, touched or not.
    pub reset: bool,
    /// A command the user started (D16); `reset` implies it.
    pub user_initiated: bool,
    /// Restore a `note-deleted` book: adopt a note that names it, or create one.
    pub restore: bool,
    /// The book holds only the highlights that changed: it can append to a touched section and
    /// nothing else, so anything more answers [`Outcome::NeedsFull`].
    pub incremental: bool,
}

/// Why a book was not written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    NoteDeleted,
    SourceDeleted,
    /// The note is open or just took a server update; it is on the retry list.
    Busy,
    /// A link state a newer build wrote.
    UnknownLink,
    /// The book's category is switched off (the run's skip, never the writer's).
    CategoryOff,
    /// A Reader document whose highlights live in a v2 book's note (D11).
    HasBook,
}

/// `UpsertOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Created(String),
    Updated(String),
    Appended(String),
    Unchanged(String),
    Skipped {
        reason: SkipReason,
        note_id: Option<String>,
    },
    Failed(String),
    /// `incremental` only: the write needs the book's full highlight list. Nothing was written.
    NeedsFull,
}

fn busy(note_id: &str) -> Outcome {
    Outcome::Skipped {
        reason: SkipReason::Busy,
        note_id: Some(note_id.to_owned()),
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub struct Writer<'a> {
    pub library: &'a Library,
    pub state: &'a RunState,
    pub base: &'a PlanBase,
}

impl Writer<'_> {
    /// `upsertReadwiseNote`: `plan` is the book's plan without images. One write at a time.
    pub fn upsert(&self, book: &ReadwiseBook, plan: &NotePlan, options: UpsertOptions) -> Outcome {
        let _one = self
            .library
            .writes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let id = book.user_book_id;
        let outcome = self.upsert_now(book, plan, options);
        let kept = match &outcome {
            Ok(Outcome::NeedsFull) => Ok(()),
            Ok(Outcome::Skipped {
                reason: SkipReason::Busy,
                ..
            }) => self.state.add_retry(id, "note-open"),
            Ok(_) => self.state.remove_retry(id),
            Err(reason) => {
                tracing::warn!(
                    scope = SCOPE,
                    book_id = id,
                    "a Readwise book could not be written: {reason}"
                );
                self.state.add_retry(id, reason)
            }
        };
        if let Err(error) = kept {
            tracing::error!(
                scope = SCOPE,
                book_id = id,
                "the Readwise retry list could not be updated: {error}"
            );
        }
        outcome.unwrap_or_else(Outcome::Failed)
    }

    fn upsert_now(
        &self,
        book: &ReadwiseBook,
        plan: &NotePlan,
        options: UpsertOptions,
    ) -> Result<Outcome, String> {
        let store = self.library.store();
        let id = book.user_book_id;
        let external = book.external_id.as_deref().filter(|id| !id.is_empty());
        let link = store.link_for_book(id, external).map_err(text)?;
        if let Some(link) = &link {
            store.complete_link(link, id, external).map_err(text)?;
            if link.state != LinkState::Linked && !options.restore {
                let reason = match link.state {
                    LinkState::NoteDeleted => SkipReason::NoteDeleted,
                    LinkState::SourceDeleted => SkipReason::SourceDeleted,
                    _ => SkipReason::UnknownLink,
                };
                return Ok(Outcome::Skipped {
                    reason,
                    note_id: None,
                });
            }
        }
        let relink = |note_id: &str| {
            store
                .upsert_link(Some(id), external, note_id, LinkState::Linked)
                .map(drop)
                .map_err(text)
        };
        let note = match (&link, options.restore) {
            (_, true) => {
                if let Some(note) = self.book_note(book, &plan.frontmatter)? {
                    relink(&note.id)?;
                    return Ok(Outcome::Unchanged(note.id));
                }
                None
            }
            (Some(link), false) => match self.library.note(&link.note_id)? {
                Some(note) => Some(note),
                None => {
                    // A missing row also means "not indexed yet", and `note-deleted` is sticky
                    // (D9): never mark it while the vault still indexes.
                    if (self.library.indexing)() {
                        return Err("The vault is still indexing".to_owned());
                    }
                    store
                        .mark_link_state(LinkKey::Book(id), LinkState::NoteDeleted)
                        .map_err(text)?;
                    return Ok(Outcome::Skipped {
                        reason: SkipReason::NoteDeleted,
                        note_id: None,
                    });
                }
            },
            (None, false) => {
                let note = self.book_note(book, &plan.frontmatter)?;
                if let Some(note) = &note {
                    relink(&note.id)?;
                }
                note
            }
        };
        let Some(note) = note else {
            return match options.incremental {
                true => Ok(Outcome::NeedsFull),
                false => self.create(book, plan),
            };
        };
        let section = read_section(&note.content);
        if options.incremental && !options.reset && section.untouched() {
            // An open note waits for the next run, so skip the full fetch for it (D6).
            return Ok(match self.library.busy(&note.id, false) {
                true => busy(&note.id),
                false => Outcome::NeedsFull,
            });
        }
        if options.reset {
            return self.reset(book, plan, &note, options);
        }
        if let SectionRead::Found {
            range,
            untouched: true,
            ..
        } = &section
        {
            let images = self.images(&note, &plan.image_urls);
            let next = self.replan(book, plan, &images)?;
            let content = splice(&note.content, range.clone(), &next.section);
            if content == note.content {
                return Ok(Outcome::Unchanged(note.id));
            }
            return self.commit(&note, content, options, Outcome::Updated);
        }
        self.append(book, &note, options)
    }

    /// The book's own note, or the Reader note of its document (D11).
    fn book_note(
        &self,
        book: &ReadwiseBook,
        frontmatter: &[(&'static str, FrontmatterValue)],
    ) -> Result<Option<NoteView>, String> {
        let url = frontmatter.iter().find_map(|(key, value)| match value {
            FrontmatterValue::Text(url) if *key == "readwise_url" => Some(url.as_str()),
            _ => None,
        });
        if let Some(item) = url.and_then(parse_readwise_url)
            && let Some(note) = self.library.note_naming(&item)?
        {
            return Ok(Some(note));
        }
        match book.external_id.as_deref().filter(|id| !id.is_empty()) {
            Some(document) => self
                .library
                .note_naming(&ReadwiseItem::ReaderDocument(document.to_owned())),
            None => Ok(None),
        }
    }

    fn images(&self, note: &NoteView, urls: &[String]) -> SavedImages {
        resolve_images(self.library, &note.id, &note.path, urls)
    }

    fn replan(
        &self,
        book: &ReadwiseBook,
        plan: &NotePlan,
        images: &SavedImages,
    ) -> Result<NotePlan, String> {
        if plan.image_urls.is_empty() {
            return Ok(plan.clone());
        }
        match self.base.plan(book, images)? {
            BookPlan::Note(next) => Ok(next),
            _ => Err("The book no longer maps to a note".to_owned()),
        }
    }

    /// `commit`: reads the note again, since images downloaded meanwhile. A body that changed,
    /// or a note that turned busy, is not written over (D6).
    fn commit(
        &self,
        note: &NoteView,
        content: String,
        options: UpsertOptions,
        done: fn(String) -> Outcome,
    ) -> Result<Outcome, String> {
        let latest = self.library.note(&note.id)?;
        if latest.is_none_or(|latest| latest.content != note.content) {
            return Ok(busy(&note.id));
        }
        let user_started = options.user_initiated || options.reset;
        if self.library.busy(&note.id, user_started) {
            return Ok(busy(&note.id));
        }
        let input = NoteUpdateInput {
            id: note.id.clone(),
            content: Some(content),
            ..NoteUpdateInput::default()
        };
        self.library
            .notes
            .update_ignoring_inline_tags(&self.library.open, input)
            .map_err(text)?;
        Ok(done(note.id.clone()))
    }

    fn create(&self, book: &ReadwiseBook, plan: &NotePlan) -> Result<Outcome, String> {
        let (tags, properties) = split_frontmatter(&plan.frontmatter);
        let new = NewNoteFile {
            title: plan.title.clone(),
            content: plan.section.clone(),
            folder: Some(plan.folder.clone()),
            tags,
            properties,
            ..NewNoteFile::default()
        };
        let created = self
            .library
            .notes
            .create(&self.library.open, new)
            .map_err(text)?;
        let external = book.external_id.as_deref().filter(|id| !id.is_empty());
        self.library
            .store()
            .upsert_link(
                Some(book.user_book_id),
                external,
                &created.id,
                LinkState::Linked,
            )
            .map_err(text)?;
        // Images need the note to exist (D14): write the section again with them, and an
        // article's cover through `frontmatter`, the key the cover band owns.
        let images = self.images(&created, &plan.image_urls);
        if images.is_empty() {
            return Ok(Outcome::Created(created.id));
        }
        let with_images = self.replan(book, plan, &images)?;
        let cover = with_images
            .frontmatter
            .iter()
            .find(|(key, _)| *key == "cover")
            .map(|(_, value)| Map::from_iter([("cover".to_owned(), json_value(value))]));
        let content = replace_section(&created.content, &with_images.section)?;
        let input = NoteUpdateInput {
            id: created.id.clone(),
            content: Some(content),
            frontmatter: cover,
            ..NoteUpdateInput::default()
        };
        self.library
            .notes
            .update_ignoring_inline_tags(&self.library.open, input)
            .map_err(text)?;
        Ok(Outcome::Created(created.id))
    }

    /// Re-import (D16): the section from the full book replaces the old one, touched or not.
    /// Without a readable pair of markers it goes at the end, the stray markers removed.
    fn reset(
        &self,
        book: &ReadwiseBook,
        plan: &NotePlan,
        note: &NoteView,
        options: UpsertOptions,
    ) -> Result<Outcome, String> {
        let images = self.images(note, &plan.image_urls);
        let next = self.replan(book, plan, &images)?;
        let content = match read_section(&note.content) {
            SectionRead::Found { range, .. } => splice(&note.content, range, &next.section),
            SectionRead::Missing { .. } => format!(
                "{}\n\n{}",
                strip_stray_markers(&note.content).trim_end_matches(is_js_whitespace),
                next.section
            ),
        };
        if content == note.content {
            return Ok(Outcome::Unchanged(note.id.clone()));
        }
        self.commit(note, content, options, Outcome::Updated)
    }

    /// Touched section, or markers the user removed: never rewrite. Appends what is new before
    /// the end marker and moves `last`; the old hash stays, so the section stays touched.
    fn append(
        &self,
        book: &ReadwiseBook,
        note: &NoteView,
        options: UpsertOptions,
    ) -> Result<Outcome, String> {
        let body = note.content.as_str();
        let (end_line, marker, add_marker) = match read_section(body) {
            SectionRead::Found { range, marker, .. } => {
                let start = body[..range.end].rfind('\n').map_or(0, |at| at + 1);
                (Some(start..range.end), marker, false)
            }
            SectionRead::Missing { end: Some(end), .. } => (Some(end.range), end.marker, false),
            SectionRead::Missing { problem, end: None } => {
                // Without a readable end marker the state has nowhere to live: a missing one gets
                // a new marker, an inline or duplicated one is left alone.
                let missing = matches!(problem, SectionProblem::NoEnd | SectionProblem::NoStart);
                (None, None, missing)
            }
        };
        let linked = linked_highlight_ids(body);
        let highlights = book.highlights.as_deref().unwrap_or_default();
        let mut wanted: Vec<String> = Vec::new();
        for highlight in highlights {
            if linked.contains(highlight.id) {
                continue;
            }
            if let Some(url) = image_highlight_url(highlight)
                && !wanted.contains(&url)
            {
                wanted.push(url);
            }
        }
        let images = self.images(note, &wanted);
        let created = iso_string(Some(note.created as f64)).map_err(text)?;
        let append = plan_append(
            highlights,
            &PlanAppendOptions {
                last: marker.as_ref().map(|marker| marker.last.as_str()),
                note_created: &created,
                linked_ids: &linked,
                time_zone: self.base.time_zone,
                images: &images,
            },
        )
        .map_err(text)?;
        if append.markdown.is_empty() {
            return Ok(Outcome::Unchanged(note.id.clone()));
        }
        let content = match end_line {
            Some(end_line) => {
                let before = body[..end_line.start].trim_end_matches(is_js_whitespace);
                let last_line = &before[before.rfind('\n').map_or(0, |at| at + 1)..];
                let gap = if is_list_item(last_line) {
                    "\n"
                } else {
                    "\n\n"
                };
                let end_marker = match &marker {
                    Some(marker) => write_end_marker(&EndMarker {
                        last: append.last.clone(),
                        hash: marker.hash.clone(),
                    }),
                    None => body[end_line.clone()].to_owned(),
                };
                format!(
                    "{before}{gap}{}\n\n{end_marker}{}",
                    append.markdown,
                    &body[end_line.end..]
                )
            }
            None if add_marker => {
                let head = format!(
                    "{}\n\n{}\n\n",
                    body.trim_end_matches(is_js_whitespace),
                    append.markdown
                );
                let build = |hash: &str| {
                    let marker = EndMarker {
                        last: append.last.clone(),
                        hash: hash.to_owned(),
                    };
                    format!("{head}{}", write_end_marker(&marker))
                };
                let hash = touched_hash(&build);
                build(&hash)
            }
            None => format!(
                "{}\n\n{}",
                body.trim_end_matches(is_js_whitespace),
                append.markdown
            ),
        };
        self.commit(note, content, options, Outcome::Appended)
    }
}

fn splice(body: &str, range: std::ops::Range<usize>, section: &str) -> String {
    format!("{}{section}{}", &body[..range.start], &body[range.end..])
}

/// `replaceSection`.
fn replace_section(body: &str, section: &str) -> Result<String, String> {
    match read_section(body) {
        SectionRead::Found { range, .. } => Ok(splice(body, range, section)),
        SectionRead::Missing { .. } => {
            Err("The new note has no readable Readwise section".to_owned())
        }
    }
}

/// An end marker `hash` that does not match the section it closes, so the section stays
/// touched: the section's own hash, one off.
fn touched_hash(build: &dyn Fn(&str) -> String) -> String {
    let probe = build(&hash_section_body(&build("")));
    match read_section(&probe) {
        SectionRead::Found { text, .. } => {
            let hash = u32::from_str_radix(&hash_section_body(text), 16).unwrap_or(0);
            format!("{:08x}", hash.wrapping_add(1))
        }
        SectionRead::Missing { .. } => hash_section_body(&probe),
    }
}

/// `LIST_ITEM`: `^\s*(?:[-*+]|\d{1,9}[.)])\s`.
fn is_list_item(line: &str) -> bool {
    let rest = line.trim_start_matches(is_js_whitespace);
    let after = match rest.as_bytes().first() {
        Some(b'-' | b'*' | b'+') => &rest[1..],
        _ => {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            match (digits, rest.as_bytes().get(digits)) {
                (1..=9, Some(b'.' | b')')) => &rest[digits + 1..],
                _ => return false,
            }
        }
    };
    after.chars().next().is_some_and(is_js_whitespace)
}

/// `STRAY_MARKERS` removed: every `<!--\s*readwise:(?:start|end)[^>]*-->`. One pass: the only
/// `>` a match can end on is the first one after its keyword, found by a cursor that only moves
/// forward. Each byte scanned is a planner step.
pub fn strip_stray_markers(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut copied = 0;
    let mut at = 0;
    let mut next_gt = 0;
    while let Some(found) = body[at..].find("<!--") {
        steps(found + 1);
        let open = at + found;
        let after = &body[open + 4..];
        let space = after.len() - after.trim_start_matches(is_js_whitespace).len();
        steps(space);
        let keyword_at = open + 4 + space;
        let rest = &body[keyword_at..];
        let keyword = ["readwise:start", "readwise:end"]
            .into_iter()
            .find(|keyword| rest.starts_with(keyword));
        let Some(keyword) = keyword else {
            at = open + 1;
            continue;
        };
        let from = keyword_at + keyword.len();
        if next_gt < from {
            next_gt = body[from..].find('>').map_or(body.len(), |gt| from + gt);
            steps(next_gt - from);
        }
        if next_gt < body.len()
            && next_gt >= from + 2
            && body.as_bytes()[next_gt - 2..next_gt] == *b"--"
        {
            out.push_str(&body[copied..open]);
            copied = next_gt + 1;
            at = copied;
        } else {
            at = open + 1;
        }
    }
    out.push_str(&body[copied..]);
    out
}

pub(super) fn json_value(value: &FrontmatterValue) -> Value {
    match value {
        FrontmatterValue::Text(text) => Value::String(text.clone()),
        FrontmatterValue::List(items) => {
            Value::Array(items.iter().cloned().map(Value::String).collect())
        }
        FrontmatterValue::Number(number) => Value::Number(number.clone()),
    }
}

/// The plan's `tags` apart from its other properties, in order.
pub(super) fn split_frontmatter(
    frontmatter: &[(&'static str, FrontmatterValue)],
) -> (Vec<String>, Map<String, Value>) {
    let mut tags = Vec::new();
    let mut properties = Map::new();
    for (key, value) in frontmatter {
        match (*key, value) {
            ("tags", FrontmatterValue::List(list)) => tags.clone_from(list),
            ("tags", _) => {}
            (key, value) => {
                properties.insert(key.to_owned(), json_value(value));
            }
        }
    }
    (tags, properties)
}
