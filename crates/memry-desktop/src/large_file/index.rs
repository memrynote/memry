//! The sparse line-offset index and windowed line reads of the large-file viewer
//! (`vault/large-file-index.ts`).
//!
//! Nothing here holds the file. The only whole-file pass is the newline scan, which reads fixed
//! windows and keeps every `stride`-th line start; the stride doubles whenever the table passes
//! [`LINE_INDEX_MAX_CHECKPOINTS`], so the table is at most 512 KB whatever the file size. Reading
//! line L costs one positional read at checkpoint `L / stride` and a short forward scan.

use std::io;

use super::reader::PositionalRead;

/// Window the whole-file newline scan reads at a time.
pub const SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// Window a line read reads at a time. Smaller: reads are latency-sensitive.
pub const READ_CHUNK_BYTES: usize = 256 * 1024;

/// Most line starts kept: 65 536 offsets of 8 bytes, whatever the file size.
pub const LINE_INDEX_MAX_CHECKPOINTS: usize = 65_536;

/// Longest line handed to the renderer. Longer lines come back cut at this many bytes and are
/// reported, so the viewer can say so. Minified JSON is one line for the whole file.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Byte budget of one page of lines: a page ends at `count` lines or once its lines reach this
/// many bytes, and never holds zero lines (a line over the budget comes back alone).
pub const PAGE_BYTES: usize = 256 * 1024;

const NEWLINE: u8 = b'\n';
const CARRIAGE_RETURN: u8 = b'\r';

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineIndex {
    /// Byte offset of the first byte of line `i * stride`.
    pub checkpoints: Vec<u64>,
    pub stride: u64,
    pub line_count: u64,
    /// Bytes the scan read.
    pub file_bytes: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct ScanOptions {
    pub chunk_bytes: usize,
    pub max_checkpoints: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            chunk_bytes: SCAN_CHUNK_BYTES,
            max_checkpoints: LINE_INDEX_MAX_CHECKPOINTS,
        }
    }
}

/// One streaming pass over the file, building the sparse line-start table. `stop` is asked
/// before every window, and `None` comes back once it says so; `progress` hears the bytes
/// scanned after every window.
pub fn scan_line_index<R: PositionalRead + ?Sized>(
    read: &R,
    options: ScanOptions,
    stop: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64),
) -> io::Result<Option<LineIndex>> {
    let max_checkpoints = options.max_checkpoints.max(1);
    // Line 0 always starts at 0, so the table is never empty while scanning.
    let mut checkpoints: Vec<u64> = vec![0];
    let mut stride: u64 = 1;
    let mut newlines: u64 = 0;
    let mut last_byte = None;
    let mut position: u64 = 0;
    let mut buffer = vec![0u8; options.chunk_bytes.max(1)];

    loop {
        if stop() {
            return Ok(None);
        }
        let read_bytes = read.read_at(&mut buffer, position)?;
        if read_bytes == 0 {
            break;
        }
        let chunk = &buffer[..read_bytes];
        for nl in memchr::memchr_iter(NEWLINE, chunk) {
            newlines += 1;
            if newlines.is_multiple_of(stride) {
                checkpoints.push(position + nl as u64 + 1);
                if checkpoints.len() > max_checkpoints {
                    // Entry `i` addressed line `i * stride`, so entry `2i` addresses line
                    // `i * (2 * stride)`: keep every second entry and double the stride.
                    let mut write = 1;
                    for read_at in (2..checkpoints.len()).step_by(2) {
                        checkpoints[write] = checkpoints[read_at];
                        write += 1;
                    }
                    checkpoints.truncate(write);
                    stride *= 2;
                }
            }
        }
        last_byte = chunk.last().copied();
        position += read_bytes as u64;
        progress(position);
    }

    // A trailing newline closes the last line rather than opening an empty one: "a\nb\n" is two
    // lines, as every text editor says.
    let line_count = match last_byte {
        None => 0,
        Some(NEWLINE) => newlines,
        Some(_) => newlines + 1,
    };
    // The last checkpoint can address a line the trailing newline never opened.
    let mut count = checkpoints.len() as u64;
    while count > 0 && (count - 1) * stride >= line_count {
        count -= 1;
    }
    checkpoints.truncate(count as usize);
    checkpoints.shrink_to_fit();
    Ok(Some(LineIndex {
        checkpoints,
        stride,
        line_count,
        file_bytes: position,
    }))
}

#[derive(Debug, Clone, Copy)]
pub struct ReadOptions {
    pub chunk_bytes: usize,
    pub max_line_bytes: usize,
    /// Page byte budget.
    pub max_bytes: usize,
}

impl Default for ReadOptions {
    fn default() -> Self {
        Self {
            chunk_bytes: READ_CHUNK_BYTES,
            max_line_bytes: MAX_LINE_BYTES,
            max_bytes: PAGE_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinesWindow {
    pub start_line: u64,
    pub lines: Vec<String>,
    /// Absolute line numbers cut at `max_line_bytes`.
    pub truncated: Vec<u64>,
}

/// The page being filled: the lines kept so far and the line being assembled, which refuses to
/// grow past the per-line cap.
struct Page {
    window: LinesWindow,
    count: usize,
    options: ReadOptions,
    /// Lines between the checkpoint and `start_line`, read and dropped.
    skip: u64,
    /// Bytes of line text emitted so far, which is what the budget bounds.
    emitted: usize,
    pending: Vec<u8>,
    cut: bool,
}

impl Page {
    fn append(&mut self, segment: &[u8]) {
        if self.cut || segment.is_empty() {
            return;
        }
        let room = self.options.max_line_bytes - self.pending.len();
        if segment.len() >= room {
            self.pending.extend_from_slice(&segment[..room]);
            self.cut = true;
            return;
        }
        self.pending.extend_from_slice(segment);
    }

    /// Closes the current line. True once the page is full.
    fn end_line(&mut self) -> bool {
        if self.skip > 0 {
            self.skip -= 1;
        } else {
            self.emitted += self.pending.len();
            if self.cut {
                let line = self.window.start_line + self.window.lines.len() as u64;
                self.window.truncated.push(line);
            }
            self.window.lines.push(decode_line(&self.pending));
        }
        self.pending.clear();
        self.cut = false;
        // One line over the budget on its own still comes back, or the caller asks for it
        // forever.
        self.window.lines.len() >= self.count
            || (!self.window.lines.is_empty() && self.emitted >= self.options.max_bytes)
    }

    /// A cut line that will end the page: its end is not needed, and finding it could mean
    /// reading to the end of a one-line file.
    fn cut_line_ends_page(&self, line_count: u64) -> bool {
        if !self.cut || self.skip > 0 {
            return false;
        }
        let line = self.window.start_line + self.window.lines.len() as u64;
        line + 1 >= line_count
            || self.window.lines.len() + 1 >= self.count
            || self.emitted + self.pending.len() >= self.options.max_bytes
    }
}

/// Up to `count` lines from `start_line`, seeking through the index. `count` is a ceiling: the
/// page also ends once its lines reach `max_bytes`, so the caller reads `lines.len()` to learn
/// where it ended. A line is decoded only once its bytes are complete, so a character split
/// across two windows is never broken.
pub fn read_lines<R: PositionalRead + ?Sized>(
    read: &R,
    index: &LineIndex,
    start_line: u64,
    count: usize,
    options: ReadOptions,
) -> io::Result<LinesWindow> {
    let window = LinesWindow {
        start_line,
        lines: Vec::new(),
        truncated: Vec::new(),
    };
    if count == 0 || start_line >= index.line_count || index.checkpoints.is_empty() {
        return Ok(window);
    }
    let checkpoint = (start_line / index.stride).min(index.checkpoints.len() as u64 - 1);
    let mut position = index.checkpoints[checkpoint as usize];
    let mut page = Page {
        window,
        count,
        options,
        skip: start_line - checkpoint * index.stride,
        emitted: 0,
        pending: Vec::new(),
        cut: false,
    };
    let mut buffer = vec![0u8; options.chunk_bytes.max(1)];

    loop {
        let read_bytes = read.read_at(&mut buffer, position)?;
        if read_bytes == 0 {
            break;
        }
        let chunk = &buffer[..read_bytes];
        let mut from = 0;
        while from < read_bytes {
            let Some(nl) = memchr::memchr(NEWLINE, &chunk[from..]).map(|at| from + at) else {
                page.append(&chunk[from..]);
                break;
            };
            page.append(&chunk[from..nl]);
            from = nl + 1;
            if page.end_line() {
                return Ok(page.window);
            }
        }
        if page.cut_line_ends_page(index.line_count) {
            page.end_line();
            return Ok(page.window);
        }
        position += read_bytes as u64;
    }
    // A file whose last line has no newline still ends in a line.
    if page.window.lines.len() < count && (!page.pending.is_empty() || page.cut) {
        page.end_line();
    }
    Ok(page.window)
}

fn decode_line(bytes: &[u8]) -> String {
    // A CRLF file would otherwise show a stray control character on every row.
    let end = match bytes.last() {
        Some(&CARRIAGE_RETURN) => bytes.len() - 1,
        _ => bytes.len(),
    };
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}
