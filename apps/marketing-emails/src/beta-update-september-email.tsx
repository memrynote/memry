import { Fragment } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import {
  Body,
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

export const betaUpdateSeptemberContent = {
  subject: '🗒️ Memrynote September Update: Mind maps, a faster start, and Memrynote on iPhone',
  preview:
    'Turn any note into a mind map, open a new device in seconds — and the iPhone app is close.'
} as const

export type BetaUpdateSeptemberEmailProps = {
  firstName?: string
  logoUrl?: string
  iconUrl?: string
  mindMapImageUrl?: string
  blockMenuImageUrl?: string
  tablesImageUrl?: string
  personalizationImageUrl?: string
  iosImageUrl?: string
  downloadUrl?: string
  unsubscribeUrl?: string
}

const campaign = WAITLIST_CAMPAIGNS.betaUpdateSeptember

const defaultProps = {
  firstName: '',
  logoUrl: 'https://memrynote.com/memrynote-logo.png',
  iconUrl: 'https://memrynote.com/memrynote-icon.png',
  mindMapImageUrl: '',
  blockMenuImageUrl: '',
  tablesImageUrl: '',
  personalizationImageUrl: '',
  iosImageUrl: '',
  downloadUrl: trackedMemryUrl('/download/desktop', campaign, 'download_cta'),
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<BetaUpdateSeptemberEmailProps>

const homeUrl = trackedMemryUrl('/', campaign, 'logo')
const docsUrl = trackedMemryUrl('https://docs.memrynote.com/', campaign, 'docs')
const importDocsUrl = trackedMemryUrl(
  'https://docs.memrynote.com/user-guide/import',
  campaign,
  'import_docs'
)
const changelogUrl = trackedMemryUrl('/changelog', campaign, 'changelog')
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
  (props: BetaUpdateSeptemberEmailProps): ReactElement
  PreviewProps?: BetaUpdateSeptemberEmailProps
}

export const BetaUpdateSeptemberEmail: EmailComponent = (props) => {
  const {
    firstName,
    logoUrl,
    iconUrl,
    mindMapImageUrl,
    blockMenuImageUrl,
    tablesImageUrl,
    personalizationImageUrl,
    iosImageUrl,
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
      <Preview>{betaUpdateSeptemberContent.preview}</Preview>
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
            again, with the second monthly update. Last month was about new surfaces — canvas,
            projects, tags. This month is about the two things you kept asking for: making Memrynote
            faster to live in, and getting it onto your phone.
          </Text>

          <Text style={styles.paragraph}>
            The second one has a real answer now, so I am leading with it.
          </Text>

          <Spacer />

          <Heading as="h2" style={styles.h2}>
            Memrynote Is Coming to Your iPhone
          </Heading>

          <Text style={styles.paragraph}>
            The most common reply I get is some version of &ldquo;this is where I want my notes, but
            I am not at my desk.&rdquo; So the mobile app is being built right now — a real native
            iOS app, not a wrapper around the website.
          </Text>

          <Text style={styles.paragraph}>
            It is the same vault, with the same end-to-end encryption: your notes, journal, tasks
            and calendar sync to your phone and the server still cannot read any of it. Notes,
            search, the editor and the daily loop first — the things you actually reach for on a
            phone. Here is the notes list running on a real device, on a real vault.
          </Text>

          <Spacer />

          <Media
            url={iosImageUrl}
            alt="The Memrynote notes list running on an iPhone, showing folders and notes from a real vault"
            label="iOS: the notes list on an iPhone"
            hint="iosImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. One device frame on the campaign background, notes list screen. Real content and ship-quality only; nothing half-built."
          />

          <Text style={styles.paragraph}>
            <strong>Android is next, and it will not be a long wait.</strong> Both apps are built on
            the same core, so most of the work being done for iOS is work Android gets for free.
          </Text>

          <Text style={styles.paragraph}>
            I am not going to give you a date I might miss — but it is close, and when the first
            beta is ready I will send it to this list. If you want to be in the first group, just
            reply to this email with <strong>iOS</strong> or <strong>Android</strong> and I will put
            you on it. You can also follow along on the{' '}
            <Link href={roadmapUrl} style={styles.link}>
              roadmap
            </Link>
            .
          </Text>

          <Spacer />

          <Text style={styles.paragraph}>
            That is the one I know you have been waiting for. Here is everything else that shipped
            on the desktop this month.
          </Text>

          <Spacer />

          <Heading as="h2" style={styles.h2}>
            Turn Any Note Into a Mind Map
          </Heading>

          <Text style={styles.paragraph}>
            Open a note, hit the mind map button in its header, and the note&apos;s headings become
            an interactive map — with its links, lists, tasks and containers branching out from
            them. Click a node and you land on that exact spot in the note. Follow a wiki link and
            you land in the note it names.
          </Text>

          <Text style={styles.paragraph}>
            There is a toolbar to fit, zoom and copy the map, very large maps fold so they stay
            readable, and you can save any map as an editable canvas if you want to keep it and
            rearrange it by hand.
          </Text>

          <Spacer />

          <Media
            url={mindMapImageUrl}
            alt="A Memrynote note opening as an interactive mind map, with headings branching into links and tasks"
            label="Mind map: opening a note as a map, then clicking a node to jump back into the note"
            hint="mindMapImageUrl — animated GIF, 1200×630 at 2x, under 800KB. The first frame must read on its own: Outlook shows only that frame. Use a note with real headings, not lorem."
          />

          <Heading as="h2" style={styles.h2}>
            A Menu Beside Every Block
          </Heading>

          <Text style={styles.paragraph}>
            The drag handle next to a block is a real menu now. Change the block&apos;s type or
            colour, duplicate it with <span style={styles.code}>⌘D</span>, move it to another note,
            delete it, or leave a comment on it — without leaving the line you are on. Fold a
            bullet&apos;s children from the chevron beside it while you are there.
          </Text>

          <Spacer />

          <Media
            url={blockMenuImageUrl}
            alt="The Memrynote block side menu open next to a paragraph, showing type, colour, duplicate, move and comment actions"
            label="Block side menu: opening the handle menu and changing a block's type"
            hint="blockMenuImageUrl — animated GIF, 1200×630 at 2x, under 800KB. Keep the cursor visible so the interaction reads."
          />

          <Heading as="h2" style={styles.h2}>
            A New Device Is Ready in Seconds
          </Heading>

          <Text style={styles.paragraph}>
            Signing in on a second machine used to mean watching a progress bar for minutes before
            you could type. Now the vault opens in seconds and your notes and attachments download
            in the background while you work. Seeding a vault for the first time no longer pays a
            round trip per note either, so the initial push is dramatically faster.
          </Text>

          <Text style={styles.paragraph}>
            Sync also stopped getting stuck: when the server refuses a large batch the app retries
            with smaller ones until the backlog drains, and edits that were queued without a
            timestamp — a small bug that could leave a note sitting unsynced forever — get one on
            the way out.
          </Text>

          <Heading as="h2" style={styles.h2}>
            Tables You Can Actually Work In
          </Heading>

          <Text style={styles.paragraph}>
            Put images in cells, colour cells, and reach the row, column and cell menus from handles
            on the border lines. Add and remove rows and columns from the keyboard. Drag across
            cells and you select just those cells instead of grabbing the whole table. A column
            width you dragged survives reopening the note.
          </Text>

          <Spacer />

          <Media
            url={tablesImageUrl}
            alt="A Memrynote table with a coloured cell, an image inside a cell, and the column handle menu open"
            label="Tables: coloured cells, an image in a cell, and the column handle menu"
            hint="tablesImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Show the handle menu open so the new affordance is obvious."
          />

          <Heading as="h2" style={styles.h2}>
            Your Markdown Stays Yours
          </Heading>

          <Text style={styles.paragraph}>
            This is the fix I am happiest about. If you write in Memrynote and in another editor,
            Memrynote no longer rewrites your file: bullets, emphasis, headings, horizontal rules,
            line breaks, reference links and code fences stay exactly as their author wrote them.
            Multi-paragraph and nested quotes are written back intact instead of being flattened,
            toggles keep the blank lines around them and remember their fold state, and hand-written{' '}
            <span style={styles.code}>&lt;details&gt;</span> blocks are left alone.
          </Text>

          <Text style={styles.paragraph}>
            Inline mentions, link references, date pills, callouts and CriticMarkup now survive an
            external edit and a reopen too. If you kept a diff open to check what Memrynote did to
            your files, you can stop.
          </Text>

          <Heading as="h2" style={styles.h2}>
            Make It Yours
          </Heading>

          <Text style={styles.paragraph}>
            Set a custom image icon on any folder or note, from your machine or a link. Pick any
            font installed on your computer from a picker that shows each one in its own typeface.
            Drag the interface font size to the pixel you want instead of choosing between three
            fixed sizes. Reorder the sidebar sections, sort each one your way, and fold the
            navigation block away. Choose a different journal template for each day of the week.
          </Text>

          <Text style={styles.paragraph}>
            And on Windows and Linux, turn on Window Behavior in Settings → General and closing the
            window keeps Memrynote running in the tray instead of quitting.
          </Text>

          <Spacer />

          <Media
            url={personalizationImageUrl}
            alt="A Memrynote sidebar with custom folder icons, next to the font picker showing each font in its own typeface"
            label="Personalization: custom folder icons in the sidebar, and the font picker"
            hint="personalizationImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Side by side reads better than two stacked screenshots."
          />

          <Spacer />

          <Heading as="h3" style={styles.h3}>
            In Other News
          </Heading>

          <ul style={styles.list}>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                PDFs got a proper toolbar with a page number you can type into, and an embedded PDF
                scrolls the whole document instead of stopping at the first page.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Arrow keys walk the notes tree Finder-style — open, close, and step between folders
                without the mouse.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                You decide what a plain click on a tab does: reuse the current tab or open a new
                one. You can also open a sidebar row in a new tab, or beside the one you are in.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Task due-date filters — scope your list to a window, or find everything with no date
                at all.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Checklist lines written with the Obsidian Tasks plugin import as real Memrynote
                tasks. A line with a date the calendar does not have is left as written and the
                message names it, and a checklist line with no matching task stays a plain checkbox
                instead of pretending to be an uneditable task.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Canvases can be linked from a task&apos;s Related picker.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Everything agrees on where a day starts — the journal panel, search date filters,
                the Home board and the calendar widget all use your local time now.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Exported PDFs show embedded images, and exported HTML keeps them after you move or
                send the file.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Centre, right and justified text stays put after a restart, and Tab or Shift+Tab
                indents every block in a selection with one undo for the whole step.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Spelling suggestions live in the right-click menu, where you expected them.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                A failed or interrupted Windows update restores the previous version by itself,
                updates no longer apply while Windows is shutting down, and a missing Start menu
                shortcut is recreated on install.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Release notes open in a background tab instead of stealing focus, and you can check
                for updates from the menu on every platform.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Google Calendar setup moved to Settings → Calendar, and the Claude and Codex options
                in the AI panel are visible even before the CLI is installed, so you can see how to
                set them up.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                A closed sidebar stays closed across restarts and vault switches, the Tag hub&apos;s
                New tag button actually makes a tag, you can type spaces in property values again,
                and property options stop being dropped or duplicated.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Changing a reminder&apos;s time moves the one you had instead of adding a second
                one, and the picker lets you remove it.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Project task counts add up: subtasks count under their parent, and a task whose
                status was deleted shows up in the project&apos;s first status instead of nowhere.
              </p>
            </li>
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
            ))}{' '}
            — plus your tasks from{' '}
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
            . Each name goes straight to its guide. A few clicks, and it is usually faster than
            people expect.{' '}
            <Link href={downloadUrl} style={styles.link}>
              Get the latest version
            </Link>
            . Updates install themselves, so you may already be on it — check Settings if you are
            not sure.
          </Text>

          <Spacer />

          <Text style={styles.paragraph}>
            <strong>What is next:</strong> the phone apps, and a steady pass over the rough edges
            you keep finding on the desktop. We are still early and still in beta. Some things will
            break. When they do, hit the Feedback button in the app or just reply to this email —
            both land with me, and I read all of them.
          </Text>

          <Text style={styles.paragraph}>
            That is it for this month. For everything else, check out the{' '}
            <Link href={changelogUrl} style={styles.link}>
              changelog
            </Link>{' '}
            or the{' '}
            <Link href={docsUrl} style={styles.link}>
              docs
            </Link>
            .
          </Text>

          <Text style={styles.paragraph}>
            One last thing: <strong>please reply to this email.</strong> It is not a no-reply
            address — every reply lands in my inbox and I answer all of them, personally. Bugs,
            half-formed ideas, things you hate, the feature you keep waiting for: all of it is
            genuinely valuable, and most of this update exists because someone took two minutes to
            write in.
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

BetaUpdateSeptemberEmail.PreviewProps = defaultProps

export default BetaUpdateSeptemberEmail

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
