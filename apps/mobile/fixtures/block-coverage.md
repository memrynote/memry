---
tags:
  - work
---

# Mobile block coverage

Every custom Memry block and inline node, in the bytes its serializer writes.

The `tags` key above is load-bearing, not decoration. `normalizeHashTags` takes
the note's own tag list and returns the blocks untouched when it is empty, so
without it `#work` below stays literal text and the `hashTag` renderer is never
exercised.

## callout

> [!info]
> Heads up

> [!warning]
> Careful

## taskBlock

- [ ] Draft the release notes {task:fixture-parent}
  - [x] Collect the changelog {task:fixture-child}

## file

<!-- file:{"url":"memry-file://local/v/attachments/n/design-brief.pdf","name":"design-brief.pdf","size":248512,"mimeType":"application/pdf"} -->

## youtubeEmbed

![embed](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

## bookmark

![bookmark](https://example.com/a)

## toggleListItem

<details data-memry-toggle>
<summary>Collapsed toggle</summary>

Hidden until you open it

</details>

<details data-memry-toggle open>
<summary>Expanded toggle</summary>

Visible on open

</details>

## hashTag

Filed under #work for the release review.

## dateMention

Ship review lands ((date:eyJhbmNob3JJZCI6ImRtX2ZpeHR1cmVfcGxhaW4iLCJkYXRlSVNPIjoiMjAyNi0wOS0xMFQwOTowMDowMC4wMDBaIiwiaGFzVGltZSI6dHJ1ZSwiZGF0ZUZvcm1hdCI6InJlbGF0aXZlIiwicmVtaW5kIjoibm9uZSIsInRpbWVGb3JtYXQiOiJzeXN0ZW0ifQ)) with no reminder.

Code freeze starts ((date:eyJhbmNob3JJZCI6ImRtX2ZpeHR1cmVfcmVtaW5kIiwiZGF0ZUlTTyI6IjIwMjYtMDktMTdUMDA6MDA6MDAuMDAwWiIsImhhc1RpbWUiOmZhbHNlLCJkYXRlRm9ybWF0IjoiZnVsbCIsInJlbWluZCI6IjFkIiwidGltZUZvcm1hdCI6InN5c3RlbSJ9)) and reminds a day ahead.

## linkMention

Reference ((mention:https%3A%2F%2Fexample.com%2Fplain)) in the review notes.

## inlineImage

| Cell image                                             | Why a cell                                  |
| ------------------------------------------------------ | ------------------------------------------- |
| ![pic.png](memry-file://local/v/attachments/n/pic.png) | A block image has no position inside a cell |

## inlineCheckbox

| Cell checkbox      | State    |
| ------------------ | -------- |
| [x] Ship it        | ticked   |
| [ ] Write the docs | unticked |

## table

<!-- table-colors:{"0:0":{"textColor":"red"}} -->
<!-- table-layout:{"columnWidths":[120,null]} -->

| Preview                                                | Done        |
| ------------------------------------------------------ | ----------- |
| ![pic.png](memry-file://local/v/attachments/n/pic.png) | [x] Ship it |
