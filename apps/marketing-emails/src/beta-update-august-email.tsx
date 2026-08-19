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

export const betaUpdateAugustContent = {
  subject: '🗒️ Memrynote August Update: Canvas, Projects, Tags, and more!',
  preview: 'Canvas, a real project hub, tags that scale, and a long list of fixes you asked for.'
} as const

export type BetaUpdateAugustEmailProps = {
  firstName?: string
  logoUrl?: string
  iconUrl?: string
  posthogImageUrl?: string
  canvasImageUrl?: string
  projectsImageUrl?: string
  tagsImageUrl?: string
  tasksImageUrl?: string
  agentImageUrl?: string
  downloadUrl?: string
  unsubscribeUrl?: string
}

const campaign = WAITLIST_CAMPAIGNS.betaUpdateAugust

const defaultProps = {
  firstName: '',
  logoUrl: 'https://memrynote.com/memrynote-logo.png',
  iconUrl: 'https://memrynote.com/memrynote-icon.png',
  posthogImageUrl: '',
  canvasImageUrl: '',
  projectsImageUrl: '',
  tagsImageUrl: '',
  tasksImageUrl: '',
  agentImageUrl: '',
  downloadUrl: trackedMemryUrl('/download/desktop', campaign, 'download_cta'),
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<BetaUpdateAugustEmailProps>

const homeUrl = trackedMemryUrl('/', campaign, 'logo')
const docsUrl = trackedMemryUrl('https://docs.memrynote.com/', campaign, 'docs')
const importDocsUrl = trackedMemryUrl(
  'https://docs.memrynote.com/user-guide/import',
  campaign,
  'import_docs'
)
const clipperChromeUrl = trackedMemryUrl('/features/web-clipper', campaign, 'web_clipper_chrome')
const clipperFirefoxUrl = trackedMemryUrl('/features/web-clipper', campaign, 'web_clipper_firefox')
const changelogUrl = trackedMemryUrl('/changelog', campaign, 'changelog')
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
  (props: BetaUpdateAugustEmailProps): ReactElement
  PreviewProps?: BetaUpdateAugustEmailProps
}

export const BetaUpdateAugustEmail: EmailComponent = (props) => {
  const {
    firstName,
    logoUrl,
    iconUrl,
    posthogImageUrl,
    canvasImageUrl,
    projectsImageUrl,
    tagsImageUrl,
    tasksImageUrl,
    agentImageUrl,
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
      <Preview>{betaUpdateAugustContent.preview}</Preview>
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
            here with the first monthly update. I build Memrynote, and from now on I want to send
            one of these every month: what shipped, what is next, and what I still need from you.
          </Text>

          <Text style={styles.paragraph}>
            Memrynote has been out for a little over a month. Thank you — genuinely. More people
            downloaded it, kept it open, and wrote back than I expected for a beta, and the replies
            have been detailed in a way that is rare. Almost everything below started as an email or
            an in-app report from someone reading this.
          </Text>

          <Spacer />

          <Media
            url={posthogImageUrl}
            alt="A chart showing Memrynote downloads and active users since launch"
            label="PostHog: downloads and active users since launch"
            hint="posthogImageUrl — PostHog chart for the first month. 1200×630 PNG or JPG at 2x, under 300KB. Crop to the chart itself: no browser chrome, no internal project names."
          />

          <Heading as="h2" style={styles.h2}>
            Canvas
          </Heading>

          <Text style={styles.paragraph}>
            A new surface for thinking spatially. Drag notes, tasks, and calendar events onto an
            infinite canvas and the cards stay live, so editing a note updates it right there on the
            canvas. This is the feature I use the most now — I stopped keeping a separate whiteboard
            app open entirely.
          </Text>

          <Text style={styles.paragraph}>
            Canvases are plain files in your vault, and they sync end-to-end encrypted like
            everything else.
          </Text>

          <Spacer />

          <Media
            url={canvasImageUrl}
            alt="Dragging a note and a task onto a Memrynote canvas, where both render as live cards"
            label="Canvas: dragging a note and a task onto the canvas"
            hint="canvasImageUrl — animated GIF, 1200×630 at 2x, under 800KB. The first frame must read on its own: Outlook shows only that frame."
          />

          <Heading as="h2" style={styles.h2}>
            Projects Got a Real Home
          </Heading>

          <Text style={styles.paragraph}>
            The project page is now a proper hub: overview, notes, tasks, files, and calendar events
            in one place. You can assign a note to a project from its properties, put an event on a
            project straight from the event form, and link records to each other with the new
            relation property.
          </Text>

          <Spacer />

          <Media
            url={projectsImageUrl}
            alt="The Memrynote project hub with overview, notes, tasks, and files tabs"
            label="Projects: the project hub with its tabs populated"
            hint="projectsImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Use a project with real notes, tasks, and files, not an empty state."
          />

          <Heading as="h2" style={styles.h2}>
            Tags That Scale
          </Heading>

          <Text style={styles.paragraph}>
            Tag categories, a tag hub to organise them, a page per tag, and tags on tasks — not just
            notes. If you were one of the people who wrote in with a screenshot of a sidebar with
            two hundred tags in it, this one is for you.
          </Text>

          <Spacer />

          <Media
            url={tagsImageUrl}
            alt="The Memrynote tag hub showing tag categories and a single-tag page"
            label="Tags: the tag hub with categories, and a single-tag page"
            hint="tagsImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Enough tags on screen to make the categories look worth having."
          />

          <Heading as="h2" style={styles.h2}>
            Tasks and the Daily Loop
          </Heading>

          <Text style={styles.paragraph}>
            Drag a task onto the calendar to schedule it. Checkboxes in your markdown files are now
            the source of truth, so an <span style={styles.code}>[x]</span> you type anywhere — even
            in another editor — completes the task. There is also a daily inbox review reminder now,
            so nothing sits there for a week.
          </Text>

          <Spacer />

          <Media
            url={tasksImageUrl}
            alt="A Memrynote task being scheduled by dragging it from the task list onto a calendar day"
            label="Tasks: dragging a task from the list onto a calendar day"
            hint="tasksImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Two panes: task list on one side, calendar with the task landed on a day."
          />

          <Heading as="h2" style={styles.h2}>
            The AI Panel Is Easier to Live With
          </Heading>

          <Text style={styles.paragraph}>
            A rebuilt composer, voice dictation, and a tool activity view that collapses into one
            line instead of flooding the chat. It still works against your vault on your machine,
            and it still asks before it writes anything.
          </Text>

          <Spacer />

          <Media
            url={agentImageUrl}
            alt="The Memrynote AI panel with the new composer, voice dictation, and a collapsed tool activity row"
            label="AI panel: the new composer with a collapsed tool activity row"
            hint="agentImageUrl — 1200×630 PNG or JPG at 2x, under 300KB. Show one finished tool run collapsed into a single row."
          />

          <Spacer />

          <Heading as="h3" style={styles.h3}>
            In Other News
          </Heading>

          <ul style={styles.list}>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Templates you can author like a normal note, and that sync across your devices.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>Bookmarks and reminders sync now too.</p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                PDFs and Obsidian-style image embeds work in the editor.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                A proper tab bar, per-note width, and a darker dark theme.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                The web clipper is live for{' '}
                <Link href={clipperChromeUrl} style={styles.link}>
                  Chrome
                </Link>{' '}
                and{' '}
                <Link href={clipperFirefoxUrl} style={styles.link}>
                  Firefox
                </Link>
                , and clipping a tab that is a PDF now saves the actual PDF.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                You can delete a vault from your account with a server-side purge — your files on
                disk stay exactly where they are.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Optional, redacted diagnostic reports for when something breaks.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                A wiki link can point at a heading, not just a note: type{' '}
                <span style={styles.code}>[[Note#Heading]]</span> and you land on the right part of
                the page.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Canvas grew up a little more: shapes can link to anything in your vault, and
                canvases now live in the folder tree, with rename, duplicate and delete.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Tabs come back where you left them — the same note, scrolled to the same place,
                instead of snapping back to the top.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>Home boards sync across your devices.</p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Quick-add reads plain language: “review notes every Tuesday at 9” becomes a
                repeating task with a real due date.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Every task keeps an activity log, so you can see what changed and when.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Comments have proper formatting now, and the editor’s floating toolbar picked up
                inline code and a labelled Comment button.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Calendar handles multiple Google accounts, with per-account calendar selection.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                The graph view is live: nodes settle into place and you can drag them around.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                In the inbox you can rename an attachment before filing it, and choose whether an
                image lands as an embed or as a wiki link.
              </p>
            </li>
            <li style={styles.listItem}>
              <p style={styles.listParagraph}>
                Plus a long list of fixes: sync reliability, editor formatting that did not survive
                a save, a due date that was off by one in some time zones, startup hangs, and undo
                on Windows and Linux.
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
            <strong>What is next:</strong> more work on projects and the canvas, and a steady pass
            over the rough edges you keep finding. We are still early and still in beta. Some things
            will break. When they do, hit the Feedback button in the app or just reply to this email
            — both land with me, and I read all of them.
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

BetaUpdateAugustEmail.PreviewProps = defaultProps

export default BetaUpdateAugustEmail

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
