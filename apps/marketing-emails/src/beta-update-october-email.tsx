import { Fragment } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text
} from 'react-email'
import { trackedMemryUrl, WAITLIST_CAMPAIGNS } from './tracking-links'

export const betaUpdateOctoberContent = {
  subject:
    '🗒️ Memrynote October Update: The iPhone beta, tags with fields, and search that reads PDFs',
  preview:
    'The iPhone beta is open to this list. Plus tags with fields, search that reads PDFs and images, and calendars beyond Google.'
} as const

export type BetaUpdateOctoberEmailProps = {
  firstName?: string
  logoUrl?: string
  iconUrl?: string
  testflightUrl?: string
  iosImageUrl?: string
  tagFieldsImageUrl?: string
  searchImageUrl?: string
  calendarImageUrl?: string
  tasksImageUrl?: string
  blocksImageUrl?: string
  agentImageUrl?: string
  themesImageUrl?: string
  downloadUrl?: string
  unsubscribeUrl?: string
}

const campaign = WAITLIST_CAMPAIGNS.betaUpdateOctober

const defaultProps = {
  firstName: '',
  logoUrl: 'https://memrynote.com/memrynote-logo.png',
  iconUrl: 'https://memrynote.com/memrynote-icon.png',
  testflightUrl: '',
  iosImageUrl: '',
  tagFieldsImageUrl: '',
  searchImageUrl: '',
  calendarImageUrl: '',
  tasksImageUrl: '',
  blocksImageUrl: '',
  agentImageUrl: '',
  themesImageUrl: '',
  downloadUrl: trackedMemryUrl('/download/desktop', campaign, 'download_cta'),
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<BetaUpdateOctoberEmailProps>

const homeUrl = trackedMemryUrl('/', campaign, 'logo')
const docsUrl = trackedMemryUrl('https://docs.memrynote.com/', campaign, 'docs')
const importDocsUrl = trackedMemryUrl(
  'https://docs.memrynote.com/user-guide/import',
  campaign,
  'import_docs'
)
// The landing /changelog page stops at the July launch, so point at the GitHub releases.
const releaseNotesUrl = trackedMemryUrl(
  'https://github.com/memrynote/memry/releases',
  campaign,
  'release_notes'
)
const roadmapUrl = trackedMemryUrl('/roadmap', campaign, 'roadmap')
const footerDownloadUrl = trackedMemryUrl('/download/desktop', campaign, 'footer_download')
const footerHomeUrl = trackedMemryUrl('/', campaign, 'footer_home')
const redditUrl = trackedMemryUrl('https://www.reddit.com/r/MemryNote/', campaign, 'reddit')
const twitterUrl = trackedMemryUrl('https://x.com/h4yfans', campaign, 'twitter')

const importSources = [
  { label: 'Notion', slug: 'notion', path: '/user-guide/import#importing-from-notion' },
  {
    label: 'Obsidian and any markdown folder',
    slug: 'markdown',
    path: '/user-guide/import#importing-from-markdown'
  },
  {
    label: 'Apple Notes',
    slug: 'apple_notes',
    path: '/user-guide/import#importing-from-apple-notes'
  },
  {
    label: 'Apple Journal',
    slug: 'apple_journal',
    path: '/user-guide/import#importing-from-apple-journal'
  },
  { label: 'Bear', slug: 'bear', path: '/user-guide/import#importing-from-bear' },
  { label: 'Evernote', slug: 'evernote', path: '/user-guide/import#importing-from-evernote' },
  { label: 'Roam Research', slug: 'roam', path: '/user-guide/import#importing-from-roam-research' },
  { label: 'NotePlan', slug: 'noteplan', path: '/user-guide/import#importing-from-noteplan' },
  {
    label: 'Google Keep',
    slug: 'google_keep',
    path: '/user-guide/import#importing-from-google-keep'
  },
  { label: 'HTML files', slug: 'html', path: '/user-guide/import#importing-from-html' },
  { label: 'CSV', slug: 'csv', path: '/user-guide/import#importing-from-csv' },
  { label: 'Todoist', slug: 'todoist', path: '/user-guide/tasks/import-todoist' },
  { label: 'TickTick', slug: 'ticktick', path: '/user-guide/tasks/import-ticktick' },
  { label: 'Raindrop', slug: 'raindrop', path: '/user-guide/import#importing-from-raindrop' }
].map((source) => ({
  ...source,
  url: trackedMemryUrl(
    `https://docs.memrynote.com${source.path}`,
    campaign,
    `import_${source.slug}`
  )
}))

const noteImportSources = importSources.slice(0, 11)
const todoistSource = importSources[11]!
const ticktickSource = importSources[12]!
const raindropSource = importSources[13]!

type EmailComponent = {
  (props: BetaUpdateOctoberEmailProps): ReactElement
  PreviewProps?: BetaUpdateOctoberEmailProps
}

export const BetaUpdateOctoberEmail: EmailComponent = (props) => {
  const {
    firstName,
    logoUrl,
    iconUrl,
    testflightUrl,
    iosImageUrl,
    tagFieldsImageUrl,
    searchImageUrl,
    calendarImageUrl,
    tasksImageUrl,
    blocksImageUrl,
    agentImageUrl,
    themesImageUrl,
    downloadUrl,
    unsubscribeUrl
  } = {
    ...defaultProps,
    ...props
  }

  const greeting = firstName ? `Hi ${firstName} 👋` : 'Hi 👋'

  return (
    <Html lang="en">
      <Head />
      <Preview>{betaUpdateOctoberContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Link href={homeUrl} style={styles.logoLink}>
            <Img src={iconUrl} alt="Memrynote" width="45" height="36" style={styles.headerIcon} />
          </Link>

          <Hr style={styles.divider} />

          <Text style={styles.paragraph}>{greeting}</Text>

          <Text style={styles.paragraph}>
            It&apos;s{' '}
            <Link href={twitterUrl} style={styles.link}>
              Kaan
            </Link>{' '}
            again, with the third monthly update. In September I said the first iPhone beta would go
            to this list. It is ready, so it goes first.
          </Text>

          <Spacer />

          <Heading as="h2" style={styles.h2}>
            The iPhone Beta Is Open
          </Heading>

          <Text style={styles.paragraph}>
            Memrynote for iPhone is now in public beta on TestFlight. It is a native app, and it
            opens the same vault as your desktop with the same end-to-end encryption. Your notes,
            tasks, journal and calendar sync to your phone, and the server still cannot read any of
            it.
          </Text>

          <Text style={styles.paragraph}>
            On the phone you can write and edit notes, whiteboards included, plan and check off
            tasks, keep your journal, check your calendar, and search all of it. Share a link, a
            photo or a file to your inbox from any app, or record a voice memo that the phone turns
            into text without the audio leaving it. Home boards, the graph, canvases and Agent Chat
            are not on the phone yet.
          </Text>

          <Spacer />

          <Media
            url={iosImageUrl}
            alt="Memrynote running on an iPhone, showing a note from a real vault"
            label="iOS: Memrynote on an iPhone"
            hint="iosImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. One or two device frames on the campaign background. Real vault content, TestFlight build."
          />

          <TestflightCta url={testflightUrl} />

          <Text style={styles.paragraph}>
            You need iOS 26 or later, the TestFlight app, and a paid Memrynote plan, because the
            phone gets your vault through encrypted sync. Sign in with the email you use on the
            desktop, then scan the code from Settings → Account → Link new device on your computer,
            or type in your recovery phrase.
          </Text>

          <Text style={styles.paragraph}>
            It is a beta, so expect rough edges. Take a screenshot in TestFlight to send me
            feedback, or reply to this email. The App Store release is planned for the end of
            November. <strong>Android comes after that</strong>, on the same core as the iPhone app.
            You can follow both on the{' '}
            <Link href={roadmapUrl} style={styles.link}>
              roadmap
            </Link>
            .
          </Text>

          <Spacer />

          <Text style={styles.paragraph}>
            That is the one I promised. The rest of this email is what shipped on the desktop since
            the September update: two big releases, on September 28 and October 14, and a handful of
            smaller ones in between.
          </Text>

          <Spacer />

          <Heading as="h2" style={styles.h2}>
            Tags With Fields
          </Heading>

          <Text style={styles.paragraph}>
            A tag can now carry fields. The Person tag, for example, has a Company, a Role and an
            Email, and every note you tag Person shows those fields, ready to fill in. The
            tag&apos;s own page turns into a table with a column for each field.
          </Text>

          <Text style={styles.paragraph}>
            A field can point at another note. A person&apos;s Company links to the company&apos;s
            own note, and the company&apos;s note lists everyone who points at it under Linked here.
            Start from the ready-made Person, Company, Meeting and Book tags in the Tags hub, or
            make your own. The values live in each note&apos;s frontmatter, so they stay in your
            markdown.
          </Text>

          <Text style={styles.paragraph}>
            With an AI provider set up, Fill from note reads the note and suggests values for the
            empty fields. Nothing is filled in until you accept it.
          </Text>

          <Spacer />

          <Media
            url={tagFieldsImageUrl}
            alt="A Memrynote note tagged Person, with its Company, Role and Email fields filled in"
            label="Tags with fields: a Person note with its fields, and the Linked here section on the company note"
            hint="tagFieldsImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Use believable names, not lorem. Show at least one relation field."
          />

          <Heading as="h2" style={styles.h2}>
            Search That Reads Your PDFs
          </Heading>

          <Text style={styles.paragraph}>
            Search is rebuilt. Press <span style={styles.code}>⌘K</span> (Ctrl+K on Windows and
            Linux) and each result fits on one line, with a preview of the selected one beside the
            list. Type <span style={styles.code}>/</span> in the empty search box to filter by type
            or date, or <span style={styles.code}>#</span> to pick a tag.
          </Text>

          <Text style={styles.paragraph}>
            Search also finds PDFs, images and screenshots by the text inside them: a scanned
            receipt, a photo of a whiteboard, a screenshot of a slide. Memrynote reads that text on
            your device, and it stays there. English works out of the box, and you can add 31 more
            languages in Settings → General → Text recognition.
          </Text>

          <Spacer />

          <Media
            url={searchImageUrl}
            alt="Memrynote search with one-line results and a preview pane, finding a word inside a scanned PDF"
            label="Search: typing a word that only appears inside a scanned PDF, then the preview beside the results"
            hint="searchImageUrl — animated GIF, 1200×630 at 2x, under 800KB. The first frame must read on its own: Outlook shows only that frame."
          />

          <Heading as="h2" style={styles.h2}>
            Your Calendars, Not Just Google
          </Heading>

          <Text style={styles.paragraph}>
            Until now, Google was the only calendar Memrynote could show. Now you can connect
            iCloud, Fastmail, Nextcloud or any other CalDAV calendar, and events you create in
            Memrynote show up there too. You can subscribe to any ICS or webcal link, like a holiday
            or team calendar. And on a Mac, Memrynote can show the calendars you already have in the
            Calendar app without signing in to anything. Those stay read-only, stay on that Mac, and
            are never synced.
          </Text>

          <Text style={styles.paragraph}>
            A new Timeline view lays out your tasks and multi-day events as a Gantt chart. Google
            changes now show up within seconds instead of up to five minutes, an event that spans
            several days draws as one bar, and you can drag your own events to another day in month
            view.
          </Text>

          <Spacer />

          <Media
            url={calendarImageUrl}
            alt="The Memrynote calendar in Timeline view, with tasks and multi-day events laid out as a Gantt chart"
            label="Calendar: the Timeline view, with tasks and multi-day events as bars"
            hint="calendarImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Use tasks that have both a start and a due date, so the bars have length."
          />

          <Heading as="h2" style={styles.h2}>
            Tasks Where You Write Them
          </Heading>

          <Text style={styles.paragraph}>
            You can now edit a task&apos;s properties right on its line in a note or the journal,
            and the ones you set show as small chips. Shorthand works as you type:{' '}
            <span style={styles.code}>#tag @friday !high +project</span> sets a tag, a due date, a
            priority and a project in one go, and <span style={styles.code}>every weekday</span>{' '}
            makes it repeat. Select a task and single keys open its pickers:{' '}
            <span style={styles.code}>D</span> for the due date, <span style={styles.code}>P</span>{' '}
            for priority, <span style={styles.code}>R</span> for repeat.
          </Text>

          <Text style={styles.paragraph}>
            Hover a task and click its arrow to open its details beside the note, and add subtasks
            without leaving the page. Subtasks now nest as deep as you like. A task with a start
            date stays in Today from that day until you complete it. And to see only the tasks that
            live in one place, right-click a folder or a note in the sidebar and choose Show Tasks.
          </Text>

          <Spacer />

          <Media
            url={tasksImageUrl}
            alt="A task line in a Memrynote note with tag, date and priority chips, typed with quick-add shorthand"
            label="Tasks: typing #tag @friday !high on a task line, then opening its details beside the note"
            hint="tasksImageUrl — animated GIF, 1200×630 at 2x, under 800KB. Keep the cursor visible so the shorthand reads."
          />

          <Heading as="h2" style={styles.h2}>
            Columns, Callouts, Footnotes, and More
          </Heading>

          <Text style={styles.paragraph}>
            Put blocks side by side: pick 2 to 5 columns from the slash menu, or drag a block next
            to another one. Columns are saved in the format Obsidian&apos;s Multi-Column Markdown
            plugin reads. Callouts come in nine more styles, thirteen in all, and can hold lists and
            headings. Footnotes written as <span style={styles.code}>[^1]</span> show as numbered
            markers and come along when you export.
          </Text>

          <Text style={styles.paragraph}>
            There are new blocks for equations, Mermaid diagrams, a whiteboard you draw on inside
            the note, and a view that embeds a live list of notes. A note can have a cover: a photo
            from Unsplash, a link or your own files, or a colour wash. You can crop an image without
            touching the original file, and videos play inline.
          </Text>

          <Spacer />

          <Media
            url={blocksImageUrl}
            alt="A Memrynote note with a cover image, two columns, a coloured callout and a math formula"
            label="Blocks: a note with a cover image, two columns, a callout and a math block"
            hint="blocksImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. One note that shows several new blocks at once."
          />

          <Heading as="h2" style={styles.h2}>
            An Agent That Asks First
          </Heading>

          <Text style={styles.paragraph}>
            Agent Chat now asks before it changes anything in your vault. When it wants to edit a
            note or a journal entry, the edit shows up marked inside the note, and nothing is saved
            until you accept it. You can also change it first, or reject it.
          </Text>

          <Text style={styles.paragraph}>
            It can add small interactive HTML pages to a note, which run in a sandboxed frame.
            Antigravity CLI joins Claude Code and Codex as an agent you can use, and Google Gemini
            joins the providers for inline AI. The chat can take text files, queue your next message
            while it is still replying, and look at images and PDF pages in your vault.
          </Text>

          <Text style={styles.paragraph}>
            Your notes only reach an AI provider you picked yourself, and they go straight from your
            device to it, never through Memrynote&apos;s servers.
          </Text>

          <Spacer />

          <Media
            url={agentImageUrl}
            alt="An edit proposed by Memrynote Agent Chat, marked inside a note with Accept, Edit and Reject buttons"
            label="Agent Chat: a proposed edit marked inside the note, waiting for Accept"
            hint="agentImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Show the marked edit and the Reject / Edit / Accept bar in the same frame."
          />

          <Heading as="h2" style={styles.h2}>
            Make It Yours
          </Heading>

          <Text style={styles.paragraph}>
            Pick one of 17 colour themes, including Catppuccin, Dracula, Gruvbox, Nord, Rosé Pine
            and Tokyo Night. Scale the whole interface from 50% to 200% with{' '}
            <span style={styles.code}>⌘+</span> and <span style={styles.code}>⌘−</span> (Ctrl on
            Windows and Linux).
          </Text>

          <Text style={styles.paragraph}>
            Rebind the tab, split and zoom shortcuts in Settings → Shortcuts, and they work while
            you are typing in a note. Settings are grouped into pages and have a search box.
          </Text>

          <Text style={styles.paragraph}>
            Vaults can have icons, and you can switch between them with a two-finger swipe on the
            sidebar or with <span style={styles.code}>⌘⇧O</span> (Ctrl+Shift+O on Windows and
            Linux).
          </Text>

          <Spacer />

          <Media
            url={themesImageUrl}
            alt="The same Memrynote note in three colour themes, side by side"
            label="Make it yours: one note in three colour themes"
            hint="themesImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Three crops of the same screen read better than three full windows."
          />

          <Spacer />

          <Heading as="h3" style={styles.h3}>
            In Other News
          </Heading>

          <ul style={styles.list}>
            <NewsItem>
              Lock a note, a folder or a journal entry on the desktop to make it read-only. Neither
              you nor an AI agent can edit it until you unlock it.
            </NewsItem>
            <NewsItem>
              Save any note as a template from its ⋯ menu, and drop a template&apos;s content in at
              your cursor with <span style={styles.code}>/</span> → Insert template content.
            </NewsItem>
            <NewsItem>
              Right-click a sentence to add alternative wordings, ask AI to suggest some, or fade
              out text you might cut.
            </NewsItem>
            <NewsItem>
              The graph is editable. Hold Alt (Option on a Mac) and drag one note onto another to
              link them, right-click a note to tag it, save graph views, and pin nodes where you
              drop them.
            </NewsItem>
            <NewsItem>
              Tie a canvas section to a tag or a property, and dropping a card into it tags the note
              or sets the value.
            </NewsItem>
            <NewsItem>
              Local AI suggests similar notes and tags. It runs on your device after a one-time
              model download.
            </NewsItem>
            <NewsItem>
              If you sync, a note&apos;s info panel shows whether its latest text is on the server.
              If a note is deleted on another device while you still have unsent text in it, that
              text is kept as a new note in your inbox.
            </NewsItem>
            <NewsItem>
              Sync is more dependable: an item created on one device now reaches the others even
              when both were syncing at the same moment, deleted notes stay deleted, and empty
              folders sync.
            </NewsItem>
            <NewsItem>
              The journal folder can show in the sidebar and be split into year and month folders,
              and journal filenames can include the weekday.
            </NewsItem>
            <NewsItem>
              <span style={styles.code}>/image</span>, <span style={styles.code}>/pdf</span> and{' '}
              <span style={styles.code}>/file</span> open one picker you can drive from the
              keyboard, and its In this vault list reuses a file you already have instead of copying
              it.
            </NewsItem>
            <NewsItem>
              With a tag page open, Ctrl-click (⌘-click on a Mac) more tags in the sidebar to narrow
              it to items that carry all of them, and save that as a search.
            </NewsItem>
            <NewsItem>
              Wiki links can point at a note by its folder path, and a note&apos;s outgoing links
              sit next to its backlinks.
            </NewsItem>
            <NewsItem>
              Apple Notes import lets you pick folders and keeps tables as tables, and checklists in
              imported notes become real tasks.
            </NewsItem>
            <NewsItem>
              If you would rather keep plain checkboxes, switch off Turn checklist items into tasks
              in Settings → Editor.
            </NewsItem>
            <NewsItem>
              Settings → Vault &amp; Data has an activity log of files added or removed outside the
              app, what each import brought in, and anything skipped or failed to sync.
            </NewsItem>
            <NewsItem>
              A new version waits quietly in the sidebar instead of interrupting you with a dialog,
              and the Windows installer is now signed.
            </NewsItem>
            <NewsItem>
              Pick the spoken language for inbox voice memos, which Memrynote transcribes on your
              device by default.
            </NewsItem>
          </ul>

          <Spacer />

          <Heading as="h3" style={styles.h3}>
            If You Have Not Started Yet
          </Heading>

          <Text style={styles.paragraph}>
            You can{' '}
            <Link href={importDocsUrl} style={styles.link}>
              import
            </Link>{' '}
            from{' '}
            {noteImportSources.map((source, index) => (
              <Fragment key={source.slug}>
                {index > 0 ? (index === noteImportSources.length - 1 ? ', and ' : ', ') : null}
                <Link href={source.url} style={styles.link}>
                  {source.label}
                </Link>
              </Fragment>
            ))}
            , plus your tasks from{' '}
            <Link href={todoistSource.url} style={styles.link}>
              Todoist
            </Link>{' '}
            and{' '}
            <Link href={ticktickSource.url} style={styles.link}>
              TickTick
            </Link>
            , and your bookmarks from{' '}
            <Link href={raindropSource.url} style={styles.link}>
              Raindrop
            </Link>
            . Each name goes straight to its guide.{' '}
            <Link href={downloadUrl} style={styles.link}>
              Get the latest version
            </Link>
            . Updates install themselves, so you may already be on it. Check Settings if you are not
            sure.
          </Text>

          <Spacer />

          <Text style={styles.paragraph}>
            <strong>What is next:</strong> getting the iPhone app into the App Store, then Android.
            On the desktop, a steady pass over the rough edges you keep finding. We are still in
            beta, and some things will break. When they do, hit the Feedback button in the app or
            reply to this email. Both land with me, and I read all of them.
          </Text>

          <Text style={styles.paragraph}>
            That is it for this month. For everything else, check out the{' '}
            <Link href={releaseNotesUrl} style={styles.link}>
              full release notes
            </Link>{' '}
            or the{' '}
            <Link href={docsUrl} style={styles.link}>
              docs
            </Link>
            .
          </Text>

          <Text style={styles.paragraph}>
            One last thing: <strong>please reply to this email.</strong> It is not a no-reply
            address. Every reply lands in my inbox and I answer all of them myself. Bugs,
            half-formed ideas, things you hate, the feature you keep waiting for: all of it helps,
            and most of this update exists because someone took two minutes to write in.
          </Text>

          <Text style={styles.paragraph}>See you next month!</Text>

          <Hr style={styles.divider} />

          <Section style={styles.footer}>
            <Img src={logoUrl} alt="Memrynote" width="185" height="26" style={styles.footerLogo} />

            <Text style={styles.footerText}>
              <Link href={footerDownloadUrl} style={styles.link}>
                Download Memrynote
              </Link>{' '}
              ·{' '}
              <Link href={docsUrl} style={styles.link}>
                Docs
              </Link>{' '}
              ·{' '}
              <Link href={footerHomeUrl} style={styles.link}>
                memrynote.com
              </Link>{' '}
              ·{' '}
              <Link href={redditUrl} style={styles.link}>
                r/MemryNote
              </Link>
              <br />
              <span style={styles.footerMuted}>© 2026 Memrynote</span>
              <br />
              <Link href={unsubscribeUrl} style={styles.link}>
                <u>Unsubscribe</u>
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

function Spacer(): ReactNode {
  return (
    <Text style={styles.paragraph}>
      <br />
    </Text>
  )
}

function NewsItem({ children }: { children: ReactNode }): ReactNode {
  return (
    <li style={styles.listItem}>
      <p style={styles.listParagraph}>{children}</p>
    </li>
  )
}

function TestflightCta({ url }: { url: string }): ReactNode {
  if (!url) {
    return (
      <Text style={styles.missingLink}>
        <strong>testflightUrl is empty.</strong> Paste the public TestFlight link
        (https://testflight.apple.com/join/…) into defaultProps before sending. This CTA is the
        point of the email.
      </Text>
    )
  }

  return (
    <Section style={styles.buttonRow}>
      <Button href={trackedMemryUrl(url, campaign, 'testflight_cta')} style={styles.button}>
        Join the iPhone beta
      </Button>
    </Section>
  )
}

function Media({
  url,
  alt,
  label,
  hint
}: {
  url: string
  alt: string
  label: string
  hint: string
}): ReactNode {
  if (url) {
    return <Img src={url} alt={alt} width="100%" style={styles.mediaImage} />
  }

  return (
    <Text style={styles.mediaNote}>
      <strong>↓ {label}</strong>
      <br />
      {hint}
    </Text>
  )
}

BetaUpdateOctoberEmail.PreviewProps = defaultProps

export default BetaUpdateOctoberEmail

const systemFont =
  "-apple-system, system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif"

const accent = '#ff671a'

const styles = {
  body: {
    margin: 0,
    backgroundColor: '#ffffff',
    fontFamily: systemFont,
    fontStyle: 'normal',
    fontWeight: 400,
    fontSize: '13px',
    lineHeight: '20px',
    color: '#222222'
  },
  container: {
    width: '100%',
    maxWidth: '600px',
    margin: '0 auto',
    padding: '32px 20px',
    backgroundColor: '#ffffff'
  },
  logoLink: {
    display: 'inline-block',
    textDecoration: 'none'
  },
  headerIcon: {
    display: 'block',
    outline: 'none',
    border: 'none',
    textDecoration: 'none',
    borderRadius: '8px'
  },
  divider: {
    width: '100%',
    margin: '0 0 13px',
    border: 'none',
    borderTop: '2px solid #eaeaea'
  },
  paragraph: {
    margin: 0,
    padding: '7px 0',
    color: '#222222',
    fontSize: '13px',
    fontWeight: 400,
    lineHeight: '20px'
  },
  h2: {
    margin: 0,
    padding: '5px 0 0',
    color: '#222222',
    fontSize: '23px',
    fontWeight: 600,
    lineHeight: '34px'
  },
  h3: {
    margin: 0,
    padding: '5px 0 0',
    color: '#222222',
    fontSize: '18px',
    fontWeight: 600,
    lineHeight: '24px'
  },
  link: {
    color: accent,
    fontWeight: 400,
    textDecoration: 'underline'
  },
  buttonRow: {
    margin: '16px 0'
  },
  button: {
    display: 'inline-block',
    padding: '11px 18px',
    borderRadius: '8px',
    backgroundColor: '#000000',
    color: '#faf9f7',
    fontSize: '15px',
    fontWeight: 600,
    lineHeight: '20px',
    textAlign: 'center',
    textDecoration: 'none'
  },
  missingLink: {
    margin: '16px 0',
    padding: '10px 12px',
    border: '2px solid #d92d20',
    borderRadius: '8px',
    color: '#d92d20',
    fontSize: '13px',
    fontWeight: 400,
    lineHeight: '20px'
  },
  mediaImage: {
    display: 'block',
    outline: 'none',
    border: 'none',
    textDecoration: 'none',
    width: '100%',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '8px'
  },
  mediaNote: {
    margin: 0,
    padding: '7px 0',
    color: '#888888',
    fontSize: '12px',
    fontWeight: 400,
    lineHeight: '18px'
  },
  list: {
    margin: 0,
    padding: '0 0 13px 15px'
  },
  listItem: {
    margin: '0 0 0 13px',
    padding: '4px 0'
  },
  listParagraph: {
    margin: 0,
    padding: 0,
    color: '#222222',
    fontSize: '13px',
    fontWeight: 400,
    lineHeight: '20px'
  },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: '4px',
    backgroundColor: '#f6f6f6',
    border: '1px solid #eaeaea'
  },
  footer: {
    fontSize: '11px'
  },
  footerLogo: {
    display: 'block',
    outline: 'none',
    border: 'none',
    textDecoration: 'none',
    padding: '10px 0'
  },
  footerText: {
    margin: 0,
    padding: '7px 0',
    color: '#a8a29e',
    fontSize: '11px',
    fontWeight: 400,
    lineHeight: '18px',
    textAlign: 'center'
  },
  footerMuted: {
    color: '#a8a29e'
  }
} satisfies Record<string, CSSProperties>
