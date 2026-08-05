import type { CSSProperties, ReactElement } from 'react'
import {
  Body,
  Button,
  Container,
  Head,
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
  subject: 'Five weeks of Memrynote — here is what shipped',
  preview: 'Canvas, a rebuilt project hub, tags that scale, and a long list of fixes you asked for.'
} as const

export type BetaUpdateAugustEmailProps = {
  firstName?: string
  logoUrl?: string
  iconUrl?: string
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
const importDocsUrl = trackedMemryUrl('https://docs.memrynote.com/', campaign, 'import_docs')
const clipperUrl = trackedMemryUrl('/features/web-clipper', campaign, 'web_clipper')
const footerDownloadUrl = trackedMemryUrl('/download/desktop', campaign, 'footer_download')
const footerHomeUrl = trackedMemryUrl('/', campaign, 'footer_home')
const redditUrl = 'https://www.reddit.com/r/MemryNote/'

type EmailComponent = {
  (props: BetaUpdateAugustEmailProps): ReactElement
  PreviewProps?: BetaUpdateAugustEmailProps
}

export const BetaUpdateAugustEmail: EmailComponent = (props) => {
  const {
    firstName,
    logoUrl,
    iconUrl,
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

  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'

  return (
    <Html lang="en">
      <Head />
      <Preview>{betaUpdateAugustContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.card}>
          <Section style={styles.header}>
            <Link href={homeUrl} style={styles.logoLink}>
              <Img src={logoUrl} alt="Memrynote" width="145" height="20" style={styles.logoImage} />
            </Link>
          </Section>

          <Section style={styles.main}>
            <Text style={styles.paragraph}>{greeting}</Text>

            <Text style={styles.paragraph}>
              Memrynote has been out for a little over a month now. Thank you — genuinely. More
              people downloaded it, kept it open, and wrote back than I expected for a beta, and the
              replies have been detailed in a way that is rare.
            </Text>

            <Text style={styles.paragraph}>
              This is the first of what I would like to make a monthly note: what shipped, what is
              next, and what I still need from you. It is short.
            </Text>

            <Text style={styles.paragraphBottom}>
              <strong>
                A lot of what is below started as an email or an in-app report from someone reading
                this.
              </strong>
            </Text>

            <Hr style={styles.sectionRule} />

            <Text style={styles.sectionHeading}>Canvas</Text>

            <Text style={styles.paragraphTight}>
              A new surface for thinking spatially. Drag notes, tasks, and calendar events onto an
              infinite canvas — the cards stay live, so editing a note updates it on the canvas.
              Canvases are plain files in your vault, and they sync end-to-end encrypted like
              everything else.
            </Text>

            <Shot
              url={canvasImageUrl}
              alt="Dragging a note and a task onto a Memrynote canvas, where both render as live cards"
              label="Canvas: dragging a note and a task onto the canvas"
              hint="Animated GIF. 1140×740 captured at 2x, shown at 570px, under 800KB. The first frame must read on its own — Outlook shows only that frame."
            />

            <Text style={styles.sectionHeading}>Projects got a real home</Text>

            <Text style={styles.paragraphTight}>
              The project page is now a hub: overview, notes, tasks, files, and calendar events in
              one place. You can assign a note to a project from its properties, put an event on a
              project from the event form, and link records to each other with the new relation
              property.
            </Text>

            <Shot
              url={projectsImageUrl}
              alt="The Memrynote project hub with overview, notes, tasks, and files tabs"
              label="Projects: the project hub with its tabs populated"
              hint="1140×740 PNG or JPG captured at 2x, shown at 570px, under 300KB. Use a project with real notes, tasks, and files — not an empty state."
            />

            <Text style={styles.sectionHeading}>Tags that scale</Text>

            <Text style={styles.paragraphTight}>
              Tag categories, a tag hub to organize them, a page per tag, and tags on tasks — not
              just notes.
            </Text>

            <Shot
              url={tagsImageUrl}
              alt="The Memrynote tag hub showing tag categories and a single-tag page"
              label="Tags: the tag hub with categories, and a single-tag page"
              hint="1140×740 PNG or JPG captured at 2x, shown at 570px, under 300KB. Enough tags to make the categories look worth having."
            />

            <Text style={styles.sectionHeading}>Tasks and the daily loop</Text>

            <Text style={styles.paragraphTight}>
              Drag a task onto the calendar to schedule it. Checkboxes in your markdown files are
              now the source of truth, so an <span style={styles.code}>[x]</span> you type anywhere
              — or in another editor — completes the task. Plus a daily inbox review reminder, so
              nothing sits there for a week.
            </Text>

            <Shot
              url={tasksImageUrl}
              alt="A Memrynote task being scheduled by dragging it from the task list onto a calendar day"
              label="Tasks: dragging a task from the list onto a calendar day"
              hint="1140×740 PNG or JPG captured at 2x, shown at 570px, under 300KB. Two panes — task list on one side, calendar with the task landed on a day. Swap for the markdown checkbox shot if that reads better."
            />

            <Text style={styles.sectionHeading}>The AI panel is easier to live with</Text>

            <Text style={styles.paragraphTight}>
              A rebuilt composer, voice dictation, and a tool activity view that collapses into one
              line instead of flooding the chat. It still works against your vault on your machine,
              and it still asks before it writes anything.
            </Text>

            <Shot
              url={agentImageUrl}
              alt="The Memrynote AI panel with the new composer, voice dictation, and a collapsed tool activity row"
              label="AI panel: the new composer with voice dictation and a collapsed tool activity row"
              hint="1140×740 PNG or JPG captured at 2x, shown at 570px, under 300KB. Show one finished tool run collapsed into a single row."
            />

            <Text style={styles.sectionHeading}>And the rest</Text>

            <ul style={styles.list}>
              <li style={styles.listItem}>
                Templates you can author like a normal note, and that sync across your devices
              </li>
              <li style={styles.listItem}>Bookmarks and reminders now sync too</li>
              <li style={styles.listItem}>PDFs and Obsidian-style image embeds in the editor</li>
              <li style={styles.listItem}>
                A proper tab bar, per-note width, and a darker dark theme
              </li>
              <li style={styles.listItem}>
                The web clipper is live on the{' '}
                <Link href={clipperUrl} style={styles.inlineLink}>
                  Chrome Web Store
                </Link>
                , and on Firefox
              </li>
              <li style={styles.listItem}>
                Delete a vault from your account, with a server-side purge — your files on disk stay
              </li>
              <li style={styles.listItem}>
                Optional, redacted diagnostic reports for when something breaks
              </li>
            </ul>

            <Text style={styles.paragraph}>
              Plus a long list of fixes: sync reliability, editor formatting that did not survive a
              save, a due date that was off by one in some time zones, startup hangs, and undo on
              Windows and Linux.
            </Text>

            <Hr style={styles.sectionRule} />

            <Text style={styles.paragraphTight}>
              <strong>If you have not started yet:</strong> you can{' '}
              <Link href={importDocsUrl} style={styles.inlineLink}>
                import
              </Link>{' '}
              from Notion, Obsidian, Apple Notes, Bear, and plain markdown folders in a few clicks.
              It is usually faster than people expect.
            </Text>

            <Section style={styles.buttonRow}>
              <Button href={downloadUrl} style={styles.button}>
                Get the latest version
              </Button>
            </Section>

            <Text style={styles.paragraph}>
              Updates install themselves, so you may already be on it — check Settings if you are
              not sure.
            </Text>

            <Text style={styles.paragraphBottom}>
              <strong>What is next:</strong> more work on projects and the canvas, and a steady pass
              over the rough edges you keep finding. We are still early and still in beta. Some
              things will break. When they do, hit the Feedback button in the app or just reply to
              this email — both land with me, and I read all of them. The{' '}
              <Link href={docsUrl} style={styles.inlineLink}>
                docs
              </Link>{' '}
              cover most of what is above in more detail.
            </Text>

            <Text style={styles.paragraph}>Talk in a month.</Text>

            <Text style={styles.signoff}>Best,</Text>
            <Text style={styles.signature}>Kaan</Text>

            <Hr style={styles.hr} />
          </Section>

          <Section style={styles.footer}>
            <Section style={styles.footerLogo}>
              <Img src={iconUrl} alt="Memrynote" width="34" height="27" style={styles.logoImage} />
            </Section>

            <Text style={styles.footerLinks}>
              <Link href={footerDownloadUrl} style={styles.footerLink}>
                Download Memrynote
              </Link>{' '}
              ·{' '}
              <Link href={docsUrl} style={styles.footerLink}>
                Docs
              </Link>{' '}
              ·{' '}
              <Link href={footerHomeUrl} style={styles.footerLink}>
                memrynote.com
              </Link>{' '}
              ·{' '}
              <Link href={redditUrl} style={styles.footerLink}>
                r/MemryNote
              </Link>
            </Text>

            <Text style={styles.footerLine}>© 2026 Memrynote</Text>

            <Text style={styles.footerUnsubscribe}>
              <Link href={unsubscribeUrl} style={styles.footerLink}>
                Unsubscribe
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

function Shot({
  url,
  alt,
  label,
  hint
}: {
  url: string
  alt: string
  label: string
  hint: string
}) {
  if (url) {
    return <Img src={url} alt={alt} width="570" style={styles.shotImage} />
  }

  return (
    <Section style={styles.placeholder}>
      <Text style={styles.placeholderLabel}>{label}</Text>
      <Text style={styles.placeholderHint}>{hint}</Text>
    </Section>
  )
}

BetaUpdateAugustEmail.PreviewProps = defaultProps

export default BetaUpdateAugustEmail

const systemFont =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

const styles = {
  body: {
    margin: 0,
    backgroundColor: '#f4f3ef',
    fontFamily: systemFont,
    color: '#000000'
  },
  card: {
    width: '100%',
    maxWidth: '620px',
    margin: '0 auto',
    backgroundColor: '#faf9f7'
  },
  header: {
    padding: '13px 25px',
    minHeight: '48px'
  },
  logoLink: {
    display: 'inline-block',
    textDecoration: 'none'
  },
  logoImage: {
    display: 'block',
    maxWidth: '100%'
  },
  main: {
    padding: '32px 25px 0'
  },
  paragraph: {
    margin: '0 0 16px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  paragraphTight: {
    margin: '0 0 16px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  paragraphBottom: {
    margin: '0 0 21px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  sectionRule: {
    margin: '10px 0 26px',
    border: 'none',
    borderTop: '1px solid #e0dfdd'
  },
  sectionHeading: {
    margin: '32px 0 8px',
    color: '#000000',
    fontSize: '18px',
    fontWeight: 600,
    lineHeight: '26px'
  },
  buttonRow: {
    margin: '16px 0 21px'
  },
  button: {
    display: 'inline-block',
    padding: '11px 18px',
    borderRadius: '8px',
    backgroundColor: '#000000',
    color: '#faf9f7',
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    textAlign: 'center',
    textDecoration: 'none'
  },
  shotImage: {
    display: 'block',
    width: '100%',
    maxWidth: '570px',
    height: 'auto',
    borderRadius: '8px'
  },
  placeholder: {
    margin: '0 0 8px',
    padding: '40px 24px',
    border: '1px dashed #d0d0d0',
    borderRadius: '8px',
    backgroundColor: '#f4f3ef',
    textAlign: 'center'
  },
  placeholderLabel: {
    margin: '0 0 6px',
    color: '#555555',
    fontSize: '14px',
    lineHeight: '20px',
    fontWeight: 600
  },
  placeholderHint: {
    margin: 0,
    color: '#888888',
    fontSize: '12px',
    lineHeight: '18px'
  },
  list: {
    margin: '8px 0 16px',
    paddingLeft: '24px'
  },
  listItem: {
    margin: '0 0 8px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  inlineLink: {
    color: '#000000',
    fontWeight: 400,
    textDecoration: 'underline'
  },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: '4px',
    backgroundColor: '#f4f3ef',
    border: '1px solid #e0dfdd'
  },
  signoff: {
    margin: 0,
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  signature: {
    margin: '0 0 16px',
    color: '#000000',
    fontSize: '16px',
    lineHeight: '24px'
  },
  hr: {
    margin: '52px 0',
    border: 'none',
    borderTop: '1px solid #e0dfdd'
  },
  footer: {
    padding: '0 25px'
  },
  footerLogo: {
    margin: '0 0 21px'
  },
  footerLinks: {
    margin: '0 0 21px',
    color: '#808080',
    fontSize: '14px',
    lineHeight: '21px'
  },
  footerLink: {
    color: '#808080',
    fontWeight: 400,
    textDecoration: 'underline'
  },
  footerLine: {
    margin: '0 0 21px',
    color: '#808080',
    fontSize: '14px',
    lineHeight: '21px'
  },
  footerUnsubscribe: {
    margin: '0 0 52px',
    color: '#808080',
    fontSize: '14px',
    lineHeight: '21px'
  }
} satisfies Record<string, CSSProperties>
