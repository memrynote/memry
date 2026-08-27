# Figma foundation spec

Source file `12AJO1nkTbStIJi5vWDfAq`, page `00 · Foundations`.
Board `Foundations / Components` (node `20:617`), inner frame `20:619`.
Theme collection is White. All units are points.

## Reading notes

- "hug" means the frame has no fixed dimension on that axis. The measured value is what the sample content produces.
- Token names below are the variable bound to that property in Figma. A raw hex means no variable is bound.
- Icon strokes export as raw hex in the SVG. Variable binding on an icon stroke is not observable through the export, so each icon lists the hex plus the Theme token whose value is identical.
- Icon components are authored at 24pt with stroke width 1.75. Figma scales the stroke when an instance is resized, so the effective stroke width at other sizes is `1.75 * size / 24`. Measured values confirm this (20pt gives 1.45833, 18pt gives 1.3125, 26pt gives 1.89583).
- No node in this board carries an opacity other than 1.
- Several inner auto layout wrappers (text columns, tab items, icon rows) carry an unbound solid `#ffffff` fill. They are listed per component where present.

---

## Type ramp letter spacing

Board `Foundations / Type Ramp`, node `20:258`. Figma stores these as a percentage of font size. The px column is the resolved value and matches the rendered tracking on every style.

| #   | Style                   | Node   | Size | letterSpacing (%) | letterSpacing (px) | Zero |
| --- | ----------------------- | ------ | ---- | ----------------- | ------------------ | ---- |
| 1   | `Display/Large Title`   | 20:261 | 34   | -2                | -0.68              | no   |
| 2   | `Display/Title 1`       | 20:266 | 28   | -2                | -0.56              | no   |
| 3   | `Text/Title 2`          | 20:271 | 22   | -1                | -0.22              | no   |
| 4   | `Text/Title 3`          | 20:276 | 20   | -1                | -0.20              | no   |
| 5   | `Text/Headline`         | 20:281 | 17   | -1                | -0.17              | no   |
| 6   | `Text/Body`             | 20:286 | 17   | 0                 | 0                  | yes  |
| 7   | `Text/Body Emphasis`    | 20:291 | 17   | 0                 | 0                  | yes  |
| 8   | `Text/Callout`          | 20:296 | 16   | 0                 | 0                  | yes  |
| 9   | `Text/Subhead`          | 20:301 | 15   | 0                 | 0                  | yes  |
| 10  | `Text/Subhead Emphasis` | 20:306 | 15   | 0                 | 0                  | yes  |
| 11  | `Text/Footnote`         | 20:311 | 13   | 0                 | 0                  | yes  |
| 12  | `Text/Caption`          | 20:316 | 12   | 0                 | 0                  | yes  |
| 13  | `Text/Caption Emphasis` | 20:321 | 12   | 1                 | 0.12               | no   |
| 14  | `Text/Tab Label`        | 20:326 | 10   | 1                 | 0.10               | no   |
| 15  | `Editor/Serif Body`     | 20:331 | 18   | 0                 | 0                  | yes  |
| 16  | `Editor/Serif Title`    | 20:336 | 26   | -1                | -0.26              | no   |
| 17  | `Editor/Mono`           | 20:341 | 13   | 0                 | 0                  | yes  |

9 of 17 are exactly 0 (rows 6, 7, 8, 9, 10, 11, 12, 15, 17). 8 are non-zero (rows 1, 2, 3, 4, 5, 13, 14, 16).

---

## shell/Status Bar

Node `20:622`.

| Field         | Value                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Size          | 390 x 47 fixed                                                                                                      |
| Padding       | top 14, right 22, bottom 0, left 28                                                                                 |
| Corner radius | 0                                                                                                                   |
| Gap           | space-between, no fixed gap                                                                                         |
| Fill          | none (no fill, no variable)                                                                                         |
| Stroke        | none                                                                                                                |
| Time label    | `Text/Subhead Emphasis`, colour `text/primary`                                                                      |
| Status icons  | 70 x 14 raster/vector block, not a Lucide icon (composite cellular + wifi + battery), Lucide mapping not applicable |

## shell/Home Indicator

Node `20:636`.

| Field          | Value                                                    |
| -------------- | -------------------------------------------------------- |
| Size           | 390 x 34 fixed                                           |
| Padding        | top 0, right 0, bottom 8, left 0                         |
| Corner radius  | 0 (root)                                                 |
| Gap            | none, single child, centred horizontally, bottom aligned |
| Fill           | none (root)                                              |
| Bar (`20:637`) | 139 x 5, radius 3, fill `text/primary`                   |
| Stroke         | none                                                     |

## shell/Nav Bar — Large Title

Node `20:641`.

| Field               | Value                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| Size                | 390 x 100 fixed                                                       |
| Padding             | top 0, right 16, bottom 8, left 16                                    |
| Corner radius       | 0                                                                     |
| Gap                 | row is space-between, no fixed gap                                    |
| Fill                | `canvas/background`                                                   |
| Stroke              | none                                                                  |
| Title               | `Display/Large Title`, colour `text/primary`                          |
| Icon row gap        | 18                                                                    |
| Icons               | 24 x 24, stroke width 1.75, colour `#37352f` (matches `text/primary`) |
| Icon 1              | `icon/search`, Lucide `search` (exact name match)                     |
| Icon 2              | `icon/plus`, Lucide `plus` (exact name match)                         |
| Inner wrapper fills | `20:642` and `20:644` carry unbound `#ffffff`                         |

## shell/Nav Bar — Inline + Back

Node `20:647`.

| Field              | Value                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size               | 390 x 44 fixed                                                                                                                                           |
| Padding            | top 0, right 16, bottom 0, left 8                                                                                                                        |
| Corner radius      | 0                                                                                                                                                        |
| Gap                | row is space-between; back group inner gap 2                                                                                                             |
| Fill               | `canvas/background`                                                                                                                                      |
| Stroke             | none                                                                                                                                                     |
| Back label         | `Text/Body`, colour `tint/base`                                                                                                                          |
| Title              | `Text/Headline`, colour `text/primary`                                                                                                                   |
| Back icon          | `icon/chevron-left`, 24 x 24, stroke width 1.75, `#6366f1` (matches `tint/base`), Lucide `chevron-left` (exact name match)                               |
| Trailing icon      | `icon/more`, 24 x 24, stroke width 1.75, `#37352f` (matches `text/primary`), Lucide `ellipsis` (three dots at y 12, x 5 / 12 / 19; Figma name is `more`) |
| Inner wrapper fill | `20:648` carries unbound `#ffffff`                                                                                                                       |

## shell/Tab Bar

Node `20:655`.

| Field                 | Value                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| Size                  | 390 x 83 fixed (49 tab strip + 34 home indicator)                                |
| Padding (root)        | 0 on all sides                                                                   |
| Corner radius         | 0                                                                                |
| Fill                  | `canvas/background`                                                              |
| Stroke                | top only, 1, `line/border`                                                       |
| Tabs row (`20:656`)   | padding top 8, right 0, bottom 0, left 0; no fixed gap, 5 equal-width flex items |
| Tab item              | padding top 2, others 0; gap 4; vertical; centred                                |
| Tab icon              | 24 x 24, stroke width 1.75                                                       |
| Active icon colour    | `#6366f1` (matches `tint/base`)                                                  |
| Inactive icon colour  | `#9b9a97` (matches `text/tertiary`)                                              |
| Label                 | `Text/Tab Label`                                                                 |
| Active label colour   | `tint/base`                                                                      |
| Inactive label colour | `text/tertiary`                                                                  |
| Home indicator        | embedded `shell/Home Indicator`, 390 x 34                                        |
| Inner wrapper fills   | `20:656` and all five tab item frames carry unbound `#ffffff`                    |

Tab icons and Lucide mapping:

| Slot    | Figma icon     | Lucide         | Confidence                                                                |
| ------- | -------------- | -------------- | ------------------------------------------------------------------------- |
| Home    | `icon/home`    | `house`        | closest match; roof polyline plus body with door cutout                   |
| Notes   | `icon/note`    | `file-text`    | closest match; file with folded corner plus 2 text lines (Lucide draws 3) |
| Tasks   | `icon/task`    | `square-check` | closest match; rounded square, corner radius 4, with inner check          |
| Journal | `icon/journal` | `book-open`    | closest match; two pages plus centre spine                                |
| More    | `icon/more`    | `ellipsis`     | closest match; three dots at y 12                                         |

## Button/Primary

Node `20:675`.

| Field         | Value                                                |
| ------------- | ---------------------------------------------------- |
| Size          | 358 x 50 fixed                                       |
| Padding       | 0 on all sides (label is centred)                    |
| Corner radius | 12                                                   |
| Gap           | none, single child                                   |
| Fill          | `ui/primary`                                         |
| Stroke        | none                                                 |
| Label         | `Text/Body Emphasis`, colour `ui/primary-foreground` |

## Button/Tint

Node `20:677`.

| Field         | Value                                          |
| ------------- | ---------------------------------------------- |
| Size          | 358 x 50 fixed                                 |
| Padding       | 0 on all sides                                 |
| Corner radius | 12                                             |
| Gap           | none                                           |
| Fill          | `tint/base`                                    |
| Stroke        | none                                           |
| Label         | `Text/Body Emphasis`, colour `tint/foreground` |

## Button/Secondary

Node `20:679`.

| Field         | Value                                       |
| ------------- | ------------------------------------------- |
| Size          | 358 x 50 fixed                              |
| Padding       | 0 on all sides                              |
| Corner radius | 12                                          |
| Gap           | none                                        |
| Fill          | `canvas/surface`                            |
| Stroke        | 1, `line/border`                            |
| Label         | `Text/Body Emphasis`, colour `text/primary` |

## Button/Destructive

Node `20:681`.

| Field         | Value                                                    |
| ------------- | -------------------------------------------------------- |
| Size          | 358 x 50 fixed                                           |
| Padding       | 0 on all sides                                           |
| Corner radius | 12                                                       |
| Gap           | none                                                     |
| Fill          | `ui/destructive`                                         |
| Stroke        | none                                                     |
| Label         | `Text/Body Emphasis`, colour `ui/destructive-foreground` |

## Button/Ghost

Node `20:683`.

| Field         | Value                                    |
| ------------- | ---------------------------------------- |
| Size          | 358 x 50 fixed                           |
| Padding       | 0 on all sides                           |
| Corner radius | 12                                       |
| Gap           | none                                     |
| Fill          | none (no fill, no variable)              |
| Stroke        | none                                     |
| Label         | `Text/Body Emphasis`, colour `tint/base` |

## Field/Default

Node `20:687`, box `20:688`.

| Field             | Value                               |
| ----------------- | ----------------------------------- |
| Outer size        | 358 x 50 fixed                      |
| Outer gap         | 0                                   |
| Box size          | 358 x 50 fixed                      |
| Box padding       | top 0, right 14, bottom 0, left 14  |
| Box corner radius | 10                                  |
| Box fill          | `canvas/background`                 |
| Box stroke        | 1, `line/input`                     |
| Placeholder text  | `Text/Body`, colour `text/tertiary` |

## Field/Filled

Node `20:690`, box `20:691`.

| Field             | Value                              |
| ----------------- | ---------------------------------- |
| Outer size        | 358 x 50 fixed                     |
| Box size          | 358 x 50 fixed                     |
| Box padding       | top 0, right 14, bottom 0, left 14 |
| Box corner radius | 10                                 |
| Box fill          | `canvas/background`                |
| Box stroke        | 1, `line/input`                    |
| Value text        | `Text/Body`, colour `text/primary` |

## Field/Focused

Node `20:693`, box `20:694`.

| Field             | Value                              |
| ----------------- | ---------------------------------- |
| Outer size        | 358 x 50 fixed                     |
| Box size          | 358 x 50 fixed                     |
| Box padding       | top 0, right 14, bottom 0, left 14 |
| Box corner radius | 10                                 |
| Box fill          | `canvas/background`                |
| Box stroke        | 2, `tint/base`                     |
| Value text        | `Text/Body`, colour `text/primary` |

Stroke grows from 1 to 2 on focus. Padding does not change, so the inner content box narrows by 1 on each side.

## Field/Error

Node `20:696`, box `20:697`.

| Field             | Value                                        |
| ----------------- | -------------------------------------------- |
| Outer size        | 358 x 74 fixed (50 box + 6 gap + 18 message) |
| Outer gap         | 6, vertical                                  |
| Outer padding     | 0 on all sides                               |
| Box size          | 358 x 50 fixed                               |
| Box padding       | top 0, right 14, bottom 0, left 14           |
| Box corner radius | 10                                           |
| Box fill          | `canvas/background`                          |
| Box stroke        | 2, `ui/destructive`                          |
| Value text        | `Text/Body`, colour `text/primary`           |
| Message text      | `Text/Footnote`, colour `ui/destructive`     |

## Field/Search

Node `20:702`.

| Field            | Value                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Size             | 358 x 36 fixed                                                                                                       |
| Padding          | top 0, right 10, bottom 0, left 10                                                                                   |
| Corner radius    | 10                                                                                                                   |
| Gap              | 6                                                                                                                    |
| Fill             | `canvas/surface`                                                                                                     |
| Stroke           | none                                                                                                                 |
| Placeholder text | `Text/Callout`, colour `text/tertiary`                                                                               |
| Icon             | `icon/search`, 18 x 18, stroke width 1.3125, `#9b9a97` (matches `text/tertiary`), Lucide `search` (exact name match) |

## Control/Segmented

Node `20:707`.

| Field                   | Value                                                               |
| ----------------------- | ------------------------------------------------------------------- |
| Size                    | 358 x 34 fixed                                                      |
| Padding                 | 2 on all sides                                                      |
| Corner radius           | 9                                                                   |
| Gap                     | 2                                                                   |
| Track fill              | `canvas/surface`                                                    |
| Track stroke            | none                                                                |
| Segments                | 3 equal-width flex items, each full track height (30 after padding) |
| Active segment fill     | `canvas/card`                                                       |
| Active segment radius   | 7                                                                   |
| Active segment shadow   | 0 x, 1 y, 3 blur, 0 spread, `rgba(0,0,0,0.08)`                      |
| Inactive segment fill   | none                                                                |
| Inactive segment radius | 7                                                                   |
| Active label            | `Text/Subhead Emphasis`, colour `text/primary`                      |
| Inactive label          | `Text/Subhead Emphasis`, colour `text/secondary`                    |

## Sheet/Handle

Node `20:716`.

| Field          | Value                                 |
| -------------- | ------------------------------------- |
| Size           | 390 x 20 fixed                        |
| Padding        | 0 on all sides                        |
| Corner radius  | 0 (root)                              |
| Gap            | none, single child, centred both axes |
| Fill           | none (root)                           |
| Bar (`20:717`) | 36 x 5, radius 3, fill `line/border`  |
| Stroke         | none                                  |

## Row/Plain

Node `20:720`.

| Field              | Value                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Size               | 390 x 52 fixed                                                                                                                     |
| Padding            | top 0, right 16, bottom 0, left 16                                                                                                 |
| Corner radius      | 0                                                                                                                                  |
| Gap                | 12                                                                                                                                 |
| Fill               | `canvas/background`                                                                                                                |
| Stroke             | bottom only, 1, `line/border`                                                                                                      |
| Leading icon       | none                                                                                                                               |
| Title              | `Text/Body`, colour `text/primary`                                                                                                 |
| Trailing icon      | `icon/chevron-right`, 18 x 18, stroke width 1.3125, `#9b9a97` (matches `text/tertiary`), Lucide `chevron-right` (exact name match) |
| Inner wrapper fill | text column `20:721` carries unbound `#ffffff`                                                                                     |

## Row/Note

Node `20:724`.

| Field              | Value                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Size               | 390 x 64 fixed                                                                                                                     |
| Padding            | top 0, right 16, bottom 0, left 16                                                                                                 |
| Corner radius      | 0                                                                                                                                  |
| Gap                | 12                                                                                                                                 |
| Fill               | `canvas/background`                                                                                                                |
| Stroke             | bottom only, 1, `line/border`                                                                                                      |
| Text column gap    | 2, vertical                                                                                                                        |
| Title              | `Text/Body`, colour `text/primary`                                                                                                 |
| Subtitle           | `Text/Footnote`, colour `text/tertiary`                                                                                            |
| Leading icon       | `icon/note`, 20 x 20, stroke width 1.45833, `#9b9a97` (matches `text/tertiary`), Lucide `file-text` (closest match)                |
| Trailing icon      | `icon/chevron-right`, 18 x 18, stroke width 1.3125, `#9b9a97` (matches `text/tertiary`), Lucide `chevron-right` (exact name match) |
| Inner wrapper fill | text column `20:726` carries unbound `#ffffff`                                                                                     |

## Row/Folder

Node `20:730`.

| Field              | Value                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Size               | 390 x 64 fixed                                                                                                                     |
| Padding            | top 0, right 16, bottom 0, left 16                                                                                                 |
| Corner radius      | 0                                                                                                                                  |
| Gap                | 12                                                                                                                                 |
| Fill               | `canvas/background`                                                                                                                |
| Stroke             | bottom only, 1, `line/border`                                                                                                      |
| Text column gap    | 2, vertical                                                                                                                        |
| Title              | `Text/Body`, colour `text/primary`                                                                                                 |
| Subtitle           | `Text/Footnote`, colour `text/tertiary`                                                                                            |
| Leading icon       | `icon/folder`, 20 x 20, stroke width 1.45833, `#9b9a97` (matches `text/tertiary`), Lucide `folder` (exact name match)              |
| Trailing icon      | `icon/chevron-right`, 18 x 18, stroke width 1.3125, `#9b9a97` (matches `text/tertiary`), Lucide `chevron-right` (exact name match) |
| Inner wrapper fill | text column `20:732` carries unbound `#ffffff`                                                                                     |

## Row/Setting

Node `20:736`.

| Field              | Value                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size               | 390 x 52 fixed                                                                                                                                                                                                         |
| Padding            | top 0, right 16, bottom 0, left 16                                                                                                                                                                                     |
| Corner radius      | 0                                                                                                                                                                                                                      |
| Gap                | 12                                                                                                                                                                                                                     |
| Fill               | `canvas/background`                                                                                                                                                                                                    |
| Stroke             | bottom only, 1, `line/border`                                                                                                                                                                                          |
| Title              | `Text/Body`, colour `text/primary`                                                                                                                                                                                     |
| Leading icon       | `icon/settings`, 20 x 20, stroke width 1.45833, `#9b9a97` (matches `text/tertiary`), Lucide `sliders-horizontal` (the glyph is two horizontal sliders with knobs, not a gear, so it does not map to Lucide `settings`) |
| Trailing icon      | `icon/chevron-right`, 18 x 18, stroke width 1.3125, `#9b9a97` (matches `text/tertiary`), Lucide `chevron-right` (exact name match)                                                                                     |
| Inner wrapper fill | text column `20:738` carries unbound `#ffffff`                                                                                                                                                                         |

## Row/Section Header

Node `20:743`.

| Field         | Value                                           |
| ------------- | ----------------------------------------------- |
| Size          | 390 x 40 fixed                                  |
| Padding       | top 16, right 16, bottom 8, left 16             |
| Corner radius | 0                                               |
| Gap           | space-between, no fixed gap                     |
| Fill          | `canvas/background`                             |
| Stroke        | none                                            |
| Left label    | `Text/Caption Emphasis`, colour `text/tertiary` |
| Right count   | `Text/Caption`, colour `text/tertiary`          |
| Icons         | none                                            |

## Chip/Tag

Node `20:749`.

| Field         | Value                                                               |
| ------------- | ------------------------------------------------------------------- |
| Size          | height 26 fixed, width hugs (measured 80 for the label `#research`) |
| Padding       | top 0, right 10, bottom 0, left 10                                  |
| Corner radius | 999                                                                 |
| Gap           | none, single child                                                  |
| Fill          | `canvas/surface`                                                    |
| Stroke        | none                                                                |
| Label         | `Text/Caption Emphasis`, colour `text/secondary`                    |
| Icons         | none                                                                |

## Chip/Active

Node `20:751`.

| Field         | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| Size          | height 26 fixed, width hugs (measured 71 for the label `Overdue`) |
| Padding       | top 0, right 10, bottom 0, left 10                                |
| Corner radius | 999                                                               |
| Gap           | none                                                              |
| Fill          | `pastel/rose`                                                     |
| Stroke        | none                                                              |
| Label         | `Text/Caption Emphasis`, colour `text/primary`                    |
| Icons         | none                                                              |

## Chip/Tint

Node `20:753`.

| Field         | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| Size          | height 26 fixed, width hugs (measured 72 for the label `Snoozed`) |
| Padding       | top 0, right 10, bottom 0, left 10                                |
| Corner radius | 999                                                               |
| Gap           | none                                                              |
| Fill          | `canvas/surface`                                                  |
| Stroke        | none                                                              |
| Label         | `Text/Caption Emphasis`, colour `tint/base`                       |
| Icons         | none                                                              |

Chip group spacing on the board is gap 8 horizontal (frame `20:748`).

## Banner/Read-only

Node `20:757`.

| Field              | Value                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size               | 358 wide fixed, height hugs (measured 60 with the sample two-line content)                                                                                             |
| Padding            | top 10, right 14, bottom 10, left 14                                                                                                                                   |
| Corner radius      | 12                                                                                                                                                                     |
| Gap                | 10 horizontal                                                                                                                                                          |
| Fill               | `pastel/sand`                                                                                                                                                          |
| Stroke             | none                                                                                                                                                                   |
| Text column gap    | 2, vertical                                                                                                                                                            |
| Title              | `Text/Subhead Emphasis`, colour `text/primary`                                                                                                                         |
| Body               | `Text/Footnote`, colour `text/secondary`                                                                                                                               |
| Icon               | `icon/lock`, 20 x 20, stroke width 1.45833, `#37352f` (matches `text/primary`), Lucide `lock` (closest match; the Figma glyph adds a short keyhole line at the centre) |
| Alignment          | icon and text column top aligned                                                                                                                                       |
| Inner wrapper fill | text column `20:759` carries unbound `#ffffff`                                                                                                                         |

## Banner/Offline

Node `20:762`.

| Field              | Value                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Size               | 358 wide fixed, height hugs (measured 60)                                                                                                                    |
| Padding            | top 10, right 14, bottom 10, left 14                                                                                                                         |
| Corner radius      | 12                                                                                                                                                           |
| Gap                | 10 horizontal                                                                                                                                                |
| Fill               | `canvas/surface`                                                                                                                                             |
| Stroke             | none                                                                                                                                                         |
| Text column gap    | 2, vertical                                                                                                                                                  |
| Title              | `Text/Subhead Emphasis`, colour `text/primary`                                                                                                               |
| Body               | `Text/Footnote`, colour `text/secondary`                                                                                                                     |
| Icon               | `icon/offline`, 20 x 20, stroke width 1.45833, `#37352f` (matches `text/primary`), Lucide `wifi-off` (closest match; four arcs plus dot plus diagonal slash) |
| Alignment          | icon and text column top aligned                                                                                                                             |
| Inner wrapper fill | text column `20:764` carries unbound `#ffffff`                                                                                                               |

## Banner/Update

Node `20:767`.

| Field              | Value                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Size               | 358 wide fixed, height hugs (measured 60)                                                                                  |
| Padding            | top 10, right 14, bottom 10, left 14                                                                                       |
| Corner radius      | 12                                                                                                                         |
| Gap                | 10 horizontal                                                                                                              |
| Fill               | `pastel/rose`                                                                                                              |
| Stroke             | none                                                                                                                       |
| Text column gap    | 2, vertical                                                                                                                |
| Title              | `Text/Subhead Emphasis`, colour `text/primary`                                                                             |
| Body               | `Text/Footnote`, colour `text/secondary`                                                                                   |
| Icon               | `icon/warning`, 20 x 20, stroke width 1.45833, `#37352f` (matches `text/primary`), Lucide `triangle-alert` (closest match) |
| Alignment          | icon and text column top aligned                                                                                           |
| Inner wrapper fill | text column `20:769` carries unbound `#ffffff`                                                                             |

Banner stack spacing on the board is gap 12 vertical.

## Toast

Node `20:774`.

| Field         | Value                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Size          | 240 x 44 fixed                                                                                                             |
| Padding       | top 0, right 14, bottom 0, left 14                                                                                         |
| Corner radius | 14                                                                                                                         |
| Gap           | 10                                                                                                                         |
| Fill          | `ui/primary`                                                                                                               |
| Stroke        | none                                                                                                                       |
| Shadow        | drop shadow 0 x, 4 y, 8 blur, `rgba(0,0,0,0.14)`                                                                           |
| Label         | `Text/Subhead`, colour `ui/primary-foreground`                                                                             |
| Icon          | `icon/check`, 18 x 18, stroke width 1.3125, `#ffffff` (matches `ui/primary-foreground`), Lucide `check` (exact name match) |

Width 240 is fixed in the design, not hugged. Widen it only if the implementer accepts a deviation.

## FAB

Node `20:779`.

| Field         | Value                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Size          | 56 x 56 fixed                                                                                                             |
| Padding       | 0 on all sides                                                                                                            |
| Corner radius | 999                                                                                                                       |
| Gap           | none, single child, centred both axes                                                                                     |
| Fill          | `ui/primary`                                                                                                              |
| Stroke        | none                                                                                                                      |
| Shadow        | drop shadow 0 x, 6 y, 9 blur, `rgba(0,0,0,0.18)`                                                                          |
| Icon          | `icon/plus`, 26 x 26, stroke width 1.89583, `#ffffff` (matches `ui/primary-foreground`), Lucide `plus` (exact name match) |

## State/Empty

Node `20:783`.

| Field                     | Value                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Size                      | 358 x 190 fixed                                                                                                  |
| Padding                   | top 0, right 40, bottom 0, left 40                                                                               |
| Corner radius             | 0                                                                                                                |
| Gap                       | 10, vertical                                                                                                     |
| Alignment                 | centred both axes                                                                                                |
| Fill                      | none                                                                                                             |
| Stroke                    | none                                                                                                             |
| Icon container (`20:784`) | 24 wide x 56 tall, radius 999, fill `canvas/surface`, no padding                                                 |
| Icon                      | `icon/note`, 24 x 24, stroke width 1.75, `#9b9a97` (matches `text/tertiary`), Lucide `file-text` (closest match) |
| Title                     | `Text/Headline`, colour `text/primary`                                                                           |
| Body                      | `Text/Subhead`, colour `text/tertiary`, width 278 fixed, centre aligned, measured 40 tall (2 lines)              |

The icon container measures 24 x 56 in Figma, not 56 x 56. It has a fixed 56 height and a hugging width around the 24pt icon, and radius 999 turns it into a narrow pill. Content occupies y 26 to y 164 inside the 190 tall frame, which is 26 clear above and below. Confirm the intent with the designer before mirroring 24 x 56.

## State/Skeleton Row

Node `20:790`.

| Field            | Value                                            |
| ---------------- | ------------------------------------------------ |
| Size             | 390 x 64 fixed                                   |
| Padding          | top 14, right 16, bottom 14, left 16             |
| Corner radius    | 0                                                |
| Gap              | 8, vertical                                      |
| Fill             | `canvas/background`                              |
| Stroke           | none                                             |
| Bar 1 (`20:791`) | 220 x 12, radius 6, fill `canvas/surface-active` |
| Bar 2 (`20:792`) | 140 x 12, radius 6, fill `canvas/surface-active` |
| Icons            | none                                             |

## Progress/Sync

Node `20:795`.

| Field               | Value                                                           |
| ------------------- | --------------------------------------------------------------- |
| Size                | 358 x 46 fixed                                                  |
| Padding             | 0 on all sides                                                  |
| Corner radius       | 0 (root)                                                        |
| Gap                 | 8, vertical                                                     |
| Fill                | none (root)                                                     |
| Stroke              | none                                                            |
| Label row           | space-between, no fixed gap, full width                         |
| Left label          | `Text/Subhead`, colour `text/secondary`                         |
| Right label         | `Text/Footnote`, colour `text/tertiary`                         |
| Track (`20:799`)    | 358 x 6, radius 3, fill `canvas/surface-active`, clips content  |
| Fill bar (`20:800`) | 232 x 6, radius 3, fill `tint/base`, positioned at left 0 top 0 |
| Sample progress     | 232 / 358 = 64.8 percent                                        |
| Icons               | none                                                            |
| Inner wrapper fill  | label row `20:796` carries unbound `#ffffff`                    |

---

## Fields marked unknown

None. Every requested field resolved from the API. Two values carry an explicit caveat rather than a gap.

1. Icon stroke width is authored once at 1.75 on the 24pt icon component. The per-instance value is the scaled result, not an independently authored number.
2. Lucide names are not declared anywhere in the Figma file. Each icon row states whether the mapping is an exact name match or a closest glyph match.

---

## Deviations from Figma, decided before implementation

These are deliberate. Implement the "use" column, not the Figma column. Every one traces to a decision already recorded on the `Foundations / Motion & Interaction Spec` board (node `49:56`, "Contrast debt") or to an authoring slip confirmed against the render.

### Contrast, tertiary is decorative only

`text/tertiary` `#9b9a97` is 2.9:1 on white and fails WCAG AA at every size used here. Text carrying real information moves to `text/secondary` `#6b6966` at 5.1:1. Icons may stay tertiary, because a decorative glyph is not text.

| Surface                            | Figma           | Use              | Reason                                        |
| ---------------------------------- | --------------- | ---------------- | --------------------------------------------- |
| `Row/Note` subtitle                | `text/tertiary` | `text/secondary` | edited time and folder are essential metadata |
| `Row/Folder` subtitle              | `text/tertiary` | `text/secondary` | note count is essential metadata              |
| `Row/Section Header` left label    | `text/tertiary` | `text/secondary` | section name is essential                     |
| `Row/Section Header` right count   | `text/tertiary` | `text/secondary` | count is essential                            |
| `Field/Search` placeholder         | `text/tertiary` | `text/secondary` | placeholder states what the field searches    |
| `State/Empty` body                 | `text/tertiary` | `text/secondary` | 15pt body copy is small text for AA           |
| `Progress/Sync` right label        | `text/tertiary` | `text/secondary` | remaining count is essential                  |
| `shell/Tab Bar` inactive label     | `text/tertiary` | `text/secondary` | named explicitly in the contrast decision     |
| `shell/Tab Bar` inactive icon      | `text/tertiary` | `text/tertiary`  | unchanged, icons may stay tertiary            |
| All chevrons and leading row icons | `text/tertiary` | `text/tertiary`  | unchanged, decorative                         |
| `State/Empty` icon                 | `text/tertiary` | `text/tertiary`  | unchanged, decorative                         |
| `Field/Search` icon                | `text/tertiary` | `text/tertiary`  | unchanged, decorative                         |

### Destructive splits into fill and text

`ui/destructive` `#e03e3e` is 4.0:1 and borderline for small text. The contrast board resolves this by darkening for text only.

| Use                                                                   | Value                |
| --------------------------------------------------------------------- | -------------------- |
| Fills (`Button/Destructive` background)                               | `#e03e3e`, unchanged |
| Text (`Field/Error` message, destructive labels on light backgrounds) | `#d63333`            |

This needs one extra token beyond Figma's 30. Name it `ui/destructive-text`. It is theme data like any other, so Warm and Dark get their own value later.

### Authoring slips

| Component                             | Figma                                              | Use                                                                      | Reason                                                                                                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `State/Empty` icon container          | 24 wide x 56 tall, radius 999                      | 56 x 56, radius 999                                                      | a 24x56 pill around a 24pt icon reads as a hug-width slip, the render shows an intended circle                                                                                                                                                          |
| `Toast` width                         | 240 fixed                                          | min 240, hug content, max = screen width minus 2x gutter                 | a fixed 240 truncates any label longer than the sample                                                                                                                                                                                                  |
| `shell/Nav Bar — Inline + Back` title | `SPACE_BETWEEN` row, title is the middle flex item | title absolutely centred on the bar, both sides inset by the wider group | space-between puts the title's centre at 212 on the component, 213 on `09 · Bookmarks` and 216 on `10 · Reminder — picker` against a bar centre of 195. It is off-centre and it moves with the back label's length. iOS centres a nav title on the bar. |

### Open conflict, not resolved here

`tint/base` is `#6366f1` in Figma. `apps/desktop/src/renderer/src/assets/base.css` line 2266 sets `--default-user-accent-color: #f97316` for both `.white` and `.dark`, which is the value the desktop app actually ships. `docs/DESIGN_TOKENS.md` documents the stale indigo.

Implement `#6366f1` as Figma specifies. It is one token value, so switching costs one line. Flag it for a decision.

### Row heights

The primitives board gives `row 56`. The measured rows disagree and both are correct. `Row/Plain` and `Row/Setting` are 52. `Row/Note` and `Row/Folder` are 64. Keep `sizes.row = 56` as the token for new one-line rows, and use the measured height per variant.
