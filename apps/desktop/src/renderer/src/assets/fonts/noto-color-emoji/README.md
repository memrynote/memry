# Noto Color Emoji (COLRv1)

Bundled color emoji fallback, used by `../../emoji-font.css`.

- Source: `ofl/notocoloremoji/NotoColorEmoji-Regular.ttf` from https://github.com/google/fonts (Version 2.055).
- License: SIL Open Font License 1.1, see `OFL.txt`.
- Modification: the `SVG ` table was dropped and the result was saved as WOFF2 with fontTools. The glyphs are unchanged. Chromium renders only the COLRv1 table, so the SVG copy was 3.8 MB of dead weight.

To regenerate:

```python
from fontTools.ttLib import TTFont  # pip install fonttools brotli

font = TTFont('NotoColorEmoji-Regular.ttf')
del font['SVG ']
font.flavor = 'woff2'
font.save('NotoColorEmoji-COLRv1.woff2')
```
