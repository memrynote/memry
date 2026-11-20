---
tags:
  - notes-101
level: Beginner
summary: 'Blocks that hold other blocks: quotes, callouts, toggles and columns'
---
Some blocks hold other blocks. They give a page structure without making it long.

## Quotes

**Insert:** `> ` and a space, or the slash menu. A quote can hold more than one paragraph and can nest.

> A quote
> over two lines

> A quote with more than one paragraph
>
> Second paragraph
>
> > And a quote inside it

## Callouts

**Insert:** slash menu, **Callout**, then pick a type from the block's menu. Callouts are for the one thing the reader must not miss.

> [!info]
> An info callout with **bold** text

> [!warning]
> A warning callout

> [!error]
> An error callout

> [!success]
> A success callout

A callout can have a block color too (block menu, **Color**):

<!-- colors:{"textColor":"red"} -->
> [!warning]
> A red warning

## Toggles

**Insert:** slash menu, **Toggle list**. Click the arrow to open it. Headings fold their own section from the chevron in the margin. A toggle can hold anything, including other toggles.

<details data-memry-toggle>
<summary>A collapsed toggle</summary>

Hidden until you open it

- with a list

</details>

<details data-memry-toggle open>
<summary>An open toggle</summary>

Visible body

<details data-memry-toggle>
<summary>A toggle inside a toggle</summary>

Deeper

</details>

</details>

<!-- colors:{"backgroundColor":"blue"} -->
<details data-memry-toggle>
<summary>A blue toggle</summary>

Body

</details>

## Columns

**Insert:** slash menu, **Two columns** up to **Five columns**. Drag a block into a column, drag the divider to resize. Columns are a good fit for before and after, or a short list beside a long one.

--- start-multi-column: n101-cols
```column-settings
Number of Columns: 3
Column Size: [25%, 50%, 25%]
```

### Left

- a
- b

--- end-column ---

The middle column is wider.

<details data-memry-toggle>
<summary>A toggle in a column</summary>

Body

</details>

--- end-column ---

> [!info]
> A callout on the right

--- end-multi-column

Next: [[04 Code, math and diagrams]].
