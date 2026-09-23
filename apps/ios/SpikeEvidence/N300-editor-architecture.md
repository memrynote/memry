# N300 — text input architecture spike

**Question**: does an editable note become **one `UITextView` per block**, or
**one document-wide TextKit 2 layout**?

Every Phase F task depends on the answer, because caret behaviour, IME, undo
grouping and scroll cost all follow from it. This is the measurement, not the
opinion.

**Harness**: `apps/ios/MemryTests/EditorArchitectureSpikeTests.swift`, six
tests. Reproduce with:

```
cd apps/ios && MEMRY_SPIKE=1 xcodebuild test -project Memry.xcodeproj \
  -scheme Memry -testPlan Unit \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MemryTests/EditorArchitectureSpikeTests
```

**`MEMRY_SPIKE` is required, and the suite is otherwise off.** The harness
builds 500 real `UITextView`s and lays out a whole document, saturating the
CPU for around three seconds. Left on in the ordinary Unit run it starved the
async expectations in `ShellEvents`, which then failed on timing and said
nothing true about the shell — observed while writing this, not theorised.

**The timings below are evidence, not assertions.** The suite does not fail if
one architecture loses: a wall-clock comparison under parallel load measures
the machine as much as the code. What the tests assert is that each side
really did the work it was timed for.

**Conditions**: iPhone 17 simulator, 500 blocks of short paragraph text,
container width 358pt, `.body` Dynamic Type at the default size. Figures are
seconds, from two consecutive runs.

## What was measured

| Measurement                      | One view per block | Document-wide TextKit 2 |
| -------------------------------- | ------------------ | ----------------------- |
| Build all 500 blocks             | 0.558 / 0.809      | 0.00067 / 0.00070       |
| Lay out all 500 blocks           | 0.173 / 0.197      | 0.0203 / 0.0216         |
| **Build + lay out a screenful**  | **0.0179**         | **0.0195** (whole note) |
| **One keystroke mid-note**       | **0.000295**       | **0.00141**             |
| Blocks disturbed by one edit     | 250 of 500 (moved) | every fragment after it |
| Registry types that are not text | 9 of 18            | 9 of 18                 |

## Reading the figures

**Building all 500 views is the wrong comparison, and it is the one that
looks decisive.** Per-block loses it by three orders of magnitude — 0.8s
against 0.0007s — and that number describes an architecture nobody ships: a
lazy list holds roughly a screenful, not the whole note.

Measured against the shape that actually deploys, the gap closes and reverses:
**0.0179s for a screenful of text views against 0.0195s to lay out the whole
document**. The document-wide side cannot make this trade, because one layout
cannot be partially resident the way a list of views can — opening a note
means laying out all of it.

**A keystroke is 4.8x cheaper per-block** (0.000295s against 0.00141s). This
is the figure that matters most: a note is laid out once and typed into
thousands of times.

**Half the registry is not text.** Nine of eighteen block types — table,
image, audio, video, file, bookmark, divider, taskBlock, youtubeEmbed — are
not characters in a string. A document-wide layout can only host them as
attachments, which means building those views _anyway_ and additionally
keeping each one pinned to a character range.

**And the core's write surface is block-addressed.** Every operation in
`body_edit.rs` takes a block id (or a table id plus row and column). A
document-wide layout would need an offset-to-block reconciliation layer on
every edit — mapping a character range back to the block it belongs to — and
that layer is exactly where an edit lands on the wrong block silently.

## The honest cost of the answer

**Per-block loses caret and selection across boundaries, and that is real
work, not a rounding error.** Document-wide gets both free: crossing a
boundary is an offset change inside one range, and UIKit handles it. Per-block,
crossing is a change of first responder that the shell has to implement and
restore, and a selection spanning three blocks is three selections the shell
has to coordinate. Test
`a_caret_crosses_a_block_boundary_in_both_architectures` records both shapes
side by side so the difference is not a claim.

**Also charged to per-block**: undo grouping spans views rather than one
`UITextView`'s built-in stack, which is why N509 specifies a native undo stack
over the operations the shell issued.

## What this spike did not measure, and is not claiming

A test process cannot exercise **dictation, autocorrect, the IME candidate
window, or the VoiceOver rotor**. Nothing above is evidence about them, and
none of it is presented as such.

What can be said without measuring: all four are `UITextView` behaviours, and
per-block keeps one real `UITextView` per editable block, so each gets them
from UIKit unchanged within a block. **The risk per-block carries is at
boundaries** — an IME composing across a block break, dictation running past
the end of a paragraph — and that risk is accepted here and carried into N501,
which is the task that implements split and merge. It is listed as an open
risk rather than settled by this spike.

## Decision

**One `UITextView` per block, in a lazy list.** Recorded with its reasoning in
`specs/003-ios-note-parity/research.md` (N301).
