// A short note for the homepage hero: an intro line, where the two options go in columns on
// camera, an info callout, and the definition of the footnote the clip adds. Tagged, because an
// untagged note grows a suggested-tags row whenever local suggestions arrive.
export default function ({ cli }) {
  cli(
    'notes',
    'create',
    'Homepage hero options',
    '--folder',
    'Studio North',
    '--content',
    `Two directions for the Studio North homepage. Lea picks one by Friday.

> [!info]
> Both keep the serif headings

[^1]: Agreed at the brand workshop with Lea.
`,
    '--tag',
    'client'
  )
}
