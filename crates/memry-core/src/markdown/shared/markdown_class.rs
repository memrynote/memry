//! Port of `packages/shared/src/markdown-class.ts`: whether a markdown file may
//! become an editable note. Both bounds exist because a file with no blank
//! lines is one block however long it is (see the TypeScript for the
//! calibration).

/// Files above this never become notes.
pub const NOTE_MAX_BYTES: usize = 1024 * 1024;
/// Largest blank-line-separated block a note may contain.
pub const NOTE_MAX_BLOCK_BYTES: usize = 128 * 1024;

/// Which bound pushed a file out of note class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LargeFileReason {
    FileBytes,
    BlockBytes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarkdownClassification {
    /// `None` is note class.
    pub large_file: Option<LargeFileReason>,
    pub file_bytes: usize,
    pub largest_block_bytes: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct MarkdownClassThresholds {
    pub max_file_bytes: usize,
    pub max_block_bytes: usize,
}

impl Default for MarkdownClassThresholds {
    fn default() -> Self {
        Self {
            max_file_bytes: NOTE_MAX_BYTES,
            max_block_bytes: NOTE_MAX_BLOCK_BYTES,
        }
    }
}

/// Byte length of the largest blank-line-separated segment. A blank line holds
/// nothing but spaces, tabs or a carriage return.
pub fn largest_block_byte_length(markdown: &str) -> usize {
    scan(markdown).1
}

/// `(fileBytes, largestBlockBytes)` in one pass.
fn scan(markdown: &str) -> (usize, usize) {
    let mut largest = 0;
    let mut block = 0;
    let mut end_line = |line_bytes: usize, blank: bool, block: &mut usize| {
        if blank {
            largest = largest.max(*block);
            *block = 0;
        } else {
            if *block > 0 {
                *block += 1;
            }
            *block += line_bytes;
        }
    };
    let (mut line_bytes, mut blank) = (0, true);
    for c in markdown.chars() {
        if c == '\n' {
            end_line(line_bytes, blank, &mut block);
            line_bytes = 0;
            blank = true;
            continue;
        }
        line_bytes += c.len_utf8();
        if !matches!(c, ' ' | '\t' | '\r') {
            blank = false;
        }
    }
    end_line(line_bytes, blank, &mut block);
    (markdown.len(), largest.max(block))
}

/// `classifyMarkdownStat`: `Some` when the byte ceiling alone settles it.
pub fn classify_markdown_stat(
    file_bytes: usize,
    thresholds: MarkdownClassThresholds,
) -> Option<MarkdownClassification> {
    (file_bytes > thresholds.max_file_bytes).then_some(MarkdownClassification {
        large_file: Some(LargeFileReason::FileBytes),
        file_bytes,
        largest_block_bytes: 0,
    })
}

/// `classifyMarkdownContent`: both bounds in one pass, file size reported first.
pub fn classify_markdown_content(
    markdown: &str,
    thresholds: MarkdownClassThresholds,
) -> MarkdownClassification {
    let (file_bytes, largest_block_bytes) = scan(markdown);
    let large_file = if file_bytes > thresholds.max_file_bytes {
        Some(LargeFileReason::FileBytes)
    } else if largest_block_bytes > thresholds.max_block_bytes {
        Some(LargeFileReason::BlockBytes)
    } else {
        None
    };
    MarkdownClassification {
        large_file,
        file_bytes,
        largest_block_bytes,
    }
}
