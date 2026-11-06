//! Positional reads: every read names its byte offset, so one open file serves the index scan,
//! the page reads and a search at once without a shared cursor. `pread` on Unix, `ReadFile` with
//! an offset (`seek_read`) on Windows; a slice stands in for a file in tests, so the same code runs
//! at window sizes no fixture file would justify.

use std::fs::File;
use std::io;

/// Reads up to `buf.len()` bytes starting at `offset`, returning how many landed. Zero means the
/// end of the file. A short read is not the end.
pub trait PositionalRead: Send + Sync {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize>;
}

impl PositionalRead for File {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        loop {
            #[cfg(unix)]
            let read = std::os::unix::fs::FileExt::read_at(self, buf, offset);
            #[cfg(windows)]
            let read = std::os::windows::fs::FileExt::seek_read(self, buf, offset);
            match read {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                read => return read,
            }
        }
    }
}

impl PositionalRead for [u8] {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        let start = usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(self.len());
        let n = buf.len().min(self.len() - start);
        buf[..n].copy_from_slice(&self[start..start + n]);
        Ok(n)
    }
}

impl PositionalRead for Vec<u8> {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        self.as_slice().read_at(buf, offset)
    }
}

/// A reader that ends at `len`: the size measured when the file was opened. A file that grows
/// while it is open (a log still being written) is read as it was measured, so a scan or a search
/// always ends, and never past the viewer's ceiling.
pub struct Bounded<R> {
    inner: R,
    len: u64,
}

impl<R> Bounded<R> {
    pub fn new(inner: R, len: u64) -> Self {
        Self { inner, len }
    }
}

impl<R: PositionalRead> PositionalRead for Bounded<R> {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        let left = self.len.saturating_sub(offset);
        let n = usize::try_from(left).unwrap_or(usize::MAX).min(buf.len());
        if n == 0 {
            return Ok(0);
        }
        self.inner.read_at(&mut buf[..n], offset)
    }
}
