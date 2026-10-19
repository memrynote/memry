// The note that leaves the vault: a client brief with a %% private comment %%, a footnote, and a
// checklist item that becomes a task (the app tags it with an internal block id in the file).
// The export keeps the text and the footnote, and leaves the comment and the id out.
export const NOTE = 'Homepage hero summary'

export default function ({ cli }) {
  cli(
    'notes',
    'create',
    NOTE,
    '--folder',
    'Studio North',
    '--tag',
    'client',
    '--content',
    `Two directions for the Studio North homepage, ready for the client[^1].

%% Ask Jonas before sending: is the budget still 14k? %%

Lea picks one by Friday. Both keep the serif headings.

- [ ] Send the summary to Lea

[^1]: Agreed at the brand workshop with Lea.
`
  )
}
