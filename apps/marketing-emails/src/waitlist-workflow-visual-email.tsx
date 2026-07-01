import type { CSSProperties, ReactElement } from 'react'
import { Body, Container, Head, Hr, Html, Img, Link, Preview, Section, Text } from 'react-email'
import { trackedMemryUrl, WAITLIST_CAMPAIGNS } from './tracking-links'

export const waitlistWorkflowVisualContent = {
  subject: 'the daily loop, in pictures',
  preview: 'Notes, tasks, and calendar — shown instead of explained.'
} as const

export type WaitlistWorkflowVisualEmailProps = {
  firstName?: string
  noteTasksScreenshotUrl?: string
  tasksPageScreenshotUrl?: string
  calendarScreenshotUrl?: string
  replyToEmail?: string
  unsubscribeUrl?: string
}

const defaultProps = {
  firstName: '',
  noteTasksScreenshotUrl: 'file:///Users/h4yfans/Documents/Task.png',
  tasksPageScreenshotUrl: 'file:///Users/h4yfans/Documents/taskpage.png',
  calendarScreenshotUrl: 'file:///Users/h4yfans/Documents/cal.png',
  replyToEmail: 'kaan@memrynote.com',
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<WaitlistWorkflowVisualEmailProps>

const brandIconUrl = 'https://memrynote.com/favicon.svg'

type EmailComponent = {
  (props: WaitlistWorkflowVisualEmailProps): ReactElement
  PreviewProps?: WaitlistWorkflowVisualEmailProps
}

export const WaitlistWorkflowVisualEmail: EmailComponent = (props) => {
  const {
    firstName,
    noteTasksScreenshotUrl,
    tasksPageScreenshotUrl,
    calendarScreenshotUrl,
    replyToEmail,
    unsubscribeUrl
  } = {
    ...defaultProps,
    ...props
  }

  const greeting = firstName ? `Hey ${firstName}, it's Kaan.` : "Hey, it's Kaan."

  return (
    <Html lang="en">
      <Head />
      <Preview>{waitlistWorkflowVisualContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.logoRow}>
            <Img
              src={brandIconUrl}
              alt="Memrynote"
              width="24"
              height="24"
              style={styles.logoIcon}
            />
            <span style={styles.logoWordmark}>Memrynote</span>
          </Text>

          <Hr style={styles.headerHr} />

          <Text style={styles.wave}>👋</Text>
          <Text style={styles.paragraph}>{greeting}</Text>

          <Text style={styles.paragraph}>
            Last week I showed the editor and asked what to show next. This week: the daily loop —
            notes, tasks, and calendar — in pictures instead of paragraphs.
          </Text>

          <Text style={styles.stepTitle}>1. Write it down</Text>
          <Text style={styles.caption}>
            Tasks live inside notes, so a meeting note carries its own action items.
          </Text>
          <Screenshot
            url={noteTasksScreenshotUrl}
            alt="A Memrynote note with real tasks inside it"
            placeholderLabel="Screenshot of a note with tasks inside it"
            height={450}
          />

          <Text style={styles.stepTitle}>2. The task page pulls it together</Text>
          <Text style={styles.caption}>
            Every task from every note lands on one page — no re-entering, no separate task app.
          </Text>
          <Screenshot
            url={tasksPageScreenshotUrl}
            alt="The Memrynote task page collecting tasks from all notes"
            placeholderLabel="Screenshot of the task page"
            height={421}
          />

          <Text style={styles.stepTitle}>3. Dates don&apos;t disappear</Text>
          <Text style={styles.caption}>
            Anything with a date shows up on the calendar, and it syncs two-way with Google Calendar
            — not another app to maintain.
          </Text>
          <Screenshot
            url={calendarScreenshotUrl}
            alt="The Memrynote calendar with notes and tasks on their dates"
            placeholderLabel="Screenshot of the calendar view"
            height={433}
          />

          <Text style={styles.paragraph}>
            That&apos;s the loop. Fewer places to check before you start working.
          </Text>

          <Text style={styles.paragraph}>
            If this loop is missing a step from your day, reply and tell me. I want the launch
            defaults to match real workflows.
          </Text>

          <Text style={styles.signature}>
            — Kaan
            <br />
            <Link
              href={trackedMemryUrl('/', WAITLIST_CAMPAIGNS.workflow, 'signature')}
              style={styles.signatureLink}
            >
              memrynote.com
            </Link>
          </Text>

          <Hr style={styles.hr} />

          <Text style={styles.footer}>
            You&apos;re getting this because you joined the Memrynote waitlist. Reply to me at{' '}
            <Link href={`mailto:${replyToEmail}`} style={styles.footerLink}>
              {replyToEmail}
            </Link>{' '}
            or{' '}
            <Link href={unsubscribeUrl} style={styles.footerLink}>
              unsubscribe
            </Link>
            .
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

function Screenshot({
  url,
  alt,
  placeholderLabel,
  height
}: {
  url: string
  alt: string
  placeholderLabel: string
  height: number
}) {
  if (url) {
    return (
      <>
        <Link href={url} target="_blank">
          <Img src={url} alt={alt} width="640" height={height} style={styles.image} />
        </Link>
        <Text style={styles.imageCaption}>click to see full size</Text>
      </>
    )
  }

  return (
    <Section style={styles.placeholder}>
      <Text style={styles.placeholderLabel}>{placeholderLabel}</Text>
      <Text style={styles.placeholderHint}>
        1280×824 hosted PNG or JPG (2x, shown at 640px), under 300KB. Replace before sending.
      </Text>
    </Section>
  )
}

WaitlistWorkflowVisualEmail.PreviewProps = defaultProps

export default WaitlistWorkflowVisualEmail

const styles = {
  body: {
    margin: 0,
    backgroundColor: '#ffffff',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif',
    color: '#1a1a1a'
  },
  container: {
    width: '100%',
    maxWidth: '640px',
    margin: '0 auto',
    padding: '40px 24px'
  },
  logoRow: {
    margin: '0 0 16px',
    fontSize: '16px',
    lineHeight: '24px'
  },
  logoIcon: {
    display: 'inline-block',
    verticalAlign: 'middle',
    marginRight: '8px'
  },
  logoWordmark: {
    display: 'inline-block',
    verticalAlign: 'middle',
    color: '#1a1a1a',
    fontSize: '17px',
    fontWeight: 600,
    letterSpacing: '-0.2px'
  },
  headerHr: {
    margin: '0 0 28px',
    border: 'none',
    borderTop: '1px solid #ebebeb'
  },
  wave: {
    margin: '0 0 12px',
    fontSize: '32px',
    lineHeight: '36px'
  },
  paragraph: {
    margin: '0 0 20px',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px'
  },
  stepTitle: {
    margin: '0 0 4px',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px',
    fontWeight: 600
  },
  caption: {
    margin: '0 0 8px',
    color: '#555555',
    fontSize: '15px',
    lineHeight: '24px'
  },
  image: {
    display: 'block',
    width: '100%',
    maxWidth: '640px',
    height: 'auto',
    margin: '4px 0 8px',
    border: '1px solid #e8e8e8',
    borderRadius: '6px'
  },
  imageCaption: {
    margin: '0 0 28px',
    color: '#888888',
    fontSize: '12px',
    lineHeight: '18px'
  },
  placeholder: {
    margin: '4px 0 28px',
    padding: '40px 24px',
    border: '1px dashed #d0d0d0',
    borderRadius: '6px',
    backgroundColor: '#fafafa',
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
  signature: {
    margin: '8px 0 36px',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px'
  },
  signatureLink: {
    color: '#888888',
    fontSize: '15px',
    textDecoration: 'underline'
  },
  hr: {
    margin: '0 0 16px',
    border: 'none',
    borderTop: '1px solid #ebebeb'
  },
  footer: {
    margin: 0,
    color: '#888888',
    fontSize: '12px',
    lineHeight: '18px'
  },
  footerLink: {
    color: '#555555',
    textDecoration: 'underline'
  }
} satisfies Record<string, CSSProperties>
