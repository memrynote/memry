//! The Readwise v2 export and Reader v3 shapes the planners read (`types.ts`, `reader.ts`). Only
//! the fields the planners use are named; every field a payload may leave out or null is an
//! `Option`.

use std::collections::HashMap;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct ReadwiseTag {
    pub name: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReadwiseHighlight {
    pub id: i64,
    pub is_deleted: Option<bool>,
    pub is_discard: Option<bool>,
    pub text: Option<String>,
    pub note: Option<String>,
    pub tags: Option<Vec<ReadwiseTag>>,
    pub location: Option<f64>,
    pub location_type: Option<String>,
    pub highlighted_at: Option<String>,
    pub created_at: Option<String>,
    /// Readwise server time: the run's cursor is the newest of these.
    pub updated_at: Option<String>,
    pub readwise_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReadwiseBook {
    pub user_book_id: i64,
    pub is_deleted: Option<bool>,
    pub title: Option<String>,
    pub readable_title: Option<String>,
    pub author: Option<String>,
    pub category: Option<String>,
    pub source: Option<String>,
    pub source_url: Option<String>,
    pub readwise_url: Option<String>,
    pub cover_image_url: Option<String>,
    pub book_tags: Option<Vec<ReadwiseTag>>,
    pub document_note: Option<String>,
    pub summary: Option<String>,
    /// A Reader book's `external_id` is the Reader document's id.
    pub external_id: Option<String>,
    pub highlights: Option<Vec<ReadwiseHighlight>>,
}

/// `READWISE_CATEGORIES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadwiseCategory {
    Books,
    Articles,
    Tweets,
    Podcasts,
    Supplementals,
}

impl ReadwiseCategory {
    pub fn parse(category: &str) -> Option<Self> {
        Some(match category {
            "books" => Self::Books,
            "articles" => Self::Articles,
            "tweets" => Self::Tweets,
            "podcasts" => Self::Podcasts,
            "supplementals" => Self::Supplementals,
            _ => return None,
        })
    }
}

/// Whether the user wants a category's books synced; `None` takes the default.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct CategorySwitches {
    pub books: Option<bool>,
    pub articles: Option<bool>,
    pub tweets: Option<bool>,
    pub podcasts: Option<bool>,
    pub supplementals: Option<bool>,
}

impl CategorySwitches {
    pub fn get(&self, category: ReadwiseCategory) -> Option<bool> {
        match category {
            ReadwiseCategory::Books => self.books,
            ReadwiseCategory::Articles => self.articles,
            ReadwiseCategory::Tweets => self.tweets,
            ReadwiseCategory::Podcasts => self.podcasts,
            ReadwiseCategory::Supplementals => self.supplementals,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FolderLayout {
    ByCategory,
    Flat,
}

/// Remote image URL to the markdown path of its saved attachment. A URL missing from it is left
/// out of the output, so no remote URL reaches a note.
pub type SavedImages = HashMap<String, String>;

/// A top-level Reader v3 document, the fields the mapper reads.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ReaderDocument {
    pub id: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub source: Option<String>,
    pub category: Option<String>,
    pub location: Option<String>,
    /// An object keyed by tag name, as Reader sends it, in the order of the payload. Any JSON
    /// is kept: `planReaderNote` reads it with `Object.entries`, so the planner decides which
    /// shapes plan and which fail as TypeScript does.
    pub tags: Option<serde_json::Value>,
    pub site_name: Option<String>,
    /// Kept as the payload's number, so frontmatter writes it unchanged.
    pub word_count: Option<serde_json::Number>,
    pub published_date: Option<PublishedDate>,
    pub summary: Option<String>,
    pub image_url: Option<String>,
    pub source_url: Option<String>,
    pub notes: Option<String>,
    pub parent_id: Option<String>,
}

/// Reader's `published_date`: a date string or a Unix time.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum PublishedDate {
    Number(f64),
    Text(String),
}

/// A frontmatter value a plan writes once, at creation.
#[derive(Debug, Clone, PartialEq)]
pub enum FrontmatterValue {
    Text(String),
    List(Vec<String>),
    Number(serde_json::Number),
}

/// Frontmatter in the order the TypeScript inserts its keys.
pub type Frontmatter = Vec<(&'static str, FrontmatterValue)>;
