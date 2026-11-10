//! What `clipboard_write_image` accepts: the bytes of one PNG the page encoded, never a path. The
//! command reads no file and writes nothing but the clipboard, so a body that names a file (a vault
//! path, `/etc/passwd`) is refused as "not a PNG" rather than opened. The header is checked before
//! the decoder runs, so a PNG that declares more pixels than the caps allocates nothing.

/// The largest encoded PNG accepted. The mind map's export at scale 2 stays far below it.
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
/// The longest side accepted, the largest canvas side Chromium and WebKit draw.
pub const MAX_SIDE: u32 = 32_767;
/// The most pixels accepted: 256 MiB once decoded to RGBA.
pub const MAX_PIXELS: u64 = 64 * 1024 * 1024;

const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageRefusal {
    /// The body is not a PNG (no signature, or no IHDR chunk first).
    NotPng,
    /// The body, or the pixels its header declares, exceed the caps.
    TooLarge,
}

impl ImageRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotPng => "clipboard_image_not_png",
            Self::TooLarge => "clipboard_image_too_large",
        }
    }
}

/// The width and height the PNG's IHDR declares, once the body passes the caps.
pub fn png_size(bytes: &[u8]) -> Result<(u32, u32), ImageRefusal> {
    if bytes.len() > MAX_BYTES {
        return Err(ImageRefusal::TooLarge);
    }
    // Signature, then the first chunk: length 13, type IHDR, width and height big-endian.
    let header = bytes.get(..24).ok_or(ImageRefusal::NotPng)?;
    if header[..8] != SIGNATURE || header[8..12] != [0, 0, 0, 13] || &header[12..16] != b"IHDR" {
        return Err(ImageRefusal::NotPng);
    }
    let width = u32::from_be_bytes([header[16], header[17], header[18], header[19]]);
    let height = u32::from_be_bytes([header[20], header[21], header[22], header[23]]);
    if width == 0 || height == 0 {
        return Err(ImageRefusal::NotPng);
    }
    if width > MAX_SIDE || height > MAX_SIDE || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(ImageRefusal::TooLarge);
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = SIGNATURE.to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn a_png_header_answers_its_size() {
        assert_eq!(png_size(&header(640, 480)), Ok((640, 480)));
    }

    #[test]
    fn a_path_or_another_format_is_not_read_as_an_image() {
        for body in [
            b"/etc/passwd".as_slice(),
            b"C:\\Users\\kaan\\vault\\notes\\secret.md",
            b"memry-file://local/Users/kaan/vault/attachments/n1/a.png",
            b"GIF89a\x01\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00",
            &[],
            &SIGNATURE,
        ] {
            assert_eq!(png_size(body), Err(ImageRefusal::NotPng), "{body:?}");
        }
        // A PNG whose first chunk is not IHDR.
        let mut text_first = header(1, 1);
        text_first[12..16].copy_from_slice(b"tEXt");
        assert_eq!(png_size(&text_first), Err(ImageRefusal::NotPng));
        assert_eq!(png_size(&header(0, 10)), Err(ImageRefusal::NotPng));
    }

    #[test]
    fn a_header_that_declares_too_many_pixels_is_refused_before_decoding() {
        assert_eq!(
            png_size(&header(MAX_SIDE + 1, 1)),
            Err(ImageRefusal::TooLarge)
        );
        assert_eq!(
            png_size(&header(1, MAX_SIDE + 1)),
            Err(ImageRefusal::TooLarge)
        );
        assert_eq!(
            png_size(&header(16_384, 16_384)),
            Err(ImageRefusal::TooLarge)
        );
        assert_eq!(png_size(&header(8_192, 8_192)), Ok((8_192, 8_192)));
    }

    #[test]
    fn a_body_over_the_byte_cap_is_refused() {
        let mut body = header(10, 10);
        body.resize(MAX_BYTES + 1, 0);
        assert_eq!(png_size(&body), Err(ImageRefusal::TooLarge));
    }
}
