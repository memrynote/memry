import type { CSSProperties, ReactElement } from 'react'
import { Body, Container, Head, Hr, Html, Img, Link, Preview, Section, Text } from 'react-email'
import { trackedMemryUrl, WAITLIST_CAMPAIGNS } from './tracking-links'

export const waitlistTasksDeepDiveContent = {
  subject: 'how tasks actually work',
  preview: 'One task system across notes, journal, inbox, and calendar.'
} as const

export type WaitlistTasksDeepDiveEmailProps = {
  firstName?: string
  quickAddScreenshotUrl?: string
  noteConvertScreenshotUrl?: string
  inboxConvertScreenshotUrl?: string
  calendarTasksScreenshotUrl?: string
  replyToEmail?: string
  unsubscribeUrl?: string
}

const defaultProps = {
  firstName: '',
  quickAddScreenshotUrl: '',
  noteConvertScreenshotUrl: '',
  inboxConvertScreenshotUrl: '',
  calendarTasksScreenshotUrl: '',
  replyToEmail: 'kaan@memrynote.com',
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<WaitlistTasksDeepDiveEmailProps>

type EmailComponent = {
  (props: WaitlistTasksDeepDiveEmailProps): ReactElement
  PreviewProps?: WaitlistTasksDeepDiveEmailProps
}

export const WaitlistTasksDeepDiveEmail: EmailComponent = (props) => {
  const {
    firstName,
    quickAddScreenshotUrl,
    noteConvertScreenshotUrl,
    inboxConvertScreenshotUrl,
    calendarTasksScreenshotUrl,
    replyToEmail,
    unsubscribeUrl
  } = {
    ...defaultProps,
    ...props
  }

  const greeting = firstName ? `Hey ${firstName},` : 'Hey,'

  return (
    <Html lang="en">
      <Head />
      <Preview>{waitlistTasksDeepDiveContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.paragraph}>{greeting}</Text>

          <Text style={styles.paragraph}>
            I showed the daily loop in pictures, and a few of you asked how tasks actually work
            underneath. Fair question. It&apos;s one task system with four doors in — here they are.
          </Text>

          <Text style={styles.stepTitle}>1. Type it, dates included</Text>
          <Text style={styles.caption}>
            Quick-add understands plain language: &quot;Email Dana next Friday&quot; becomes a task
            due next Friday. Priority and project work inline too.
          </Text>
          <Screenshot
            url={quickAddScreenshotUrl}
            alt="MemryNote quick-add parsing a natural-language due date"
            placeholderLabel="Screenshot of quick-add parsing a natural-language date"
          />

          <Text style={styles.stepTitle}>2. Notes and journal entries grow tasks</Text>
          <Text style={styles.caption}>
            Any checklist line in a note or journal entry converts to a real task in one click — and
            the task keeps a link back to the note it came from. Your journal also shows the
            day&apos;s tasks right next to what you&apos;re writing.
          </Text>
          <Screenshot
            url={noteConvertScreenshotUrl}
            alt="Converting a checklist item inside a note into a task"
            placeholderLabel="Screenshot of a note checklist item converting to a task"
          />

          <Text style={styles.stepTitle}>3. Inbox captures become tasks</Text>
          <Text style={styles.caption}>
            A link, voice memo, or clipping you tossed into the inbox is often a task in disguise.
            One click in triage converts it — the original source stays attached as a reference.
          </Text>
          <Screenshot
            url={inboxConvertScreenshotUrl}
            alt="An inbox triage card with the Convert to Task action"
            placeholderLabel="Screenshot of an inbox capture converting to a task"
          />

          <Text style={styles.stepTitle}>4. Due dates land on the calendar</Text>
          <Text style={styles.caption}>
            Every task with a date shows up on the calendar on the day it&apos;s due, next to your
            events and journal days. Drag the chip to reschedule — no second app to maintain.
          </Text>
          <Screenshot
            url={calendarTasksScreenshotUrl}
            alt="The MemryNote calendar showing task chips on their due dates"
            placeholderLabel="Screenshot of tasks on the calendar"
          />

          <Text style={styles.paragraph}>
            Four doors, one system. Whether a task starts as a typed line, a sentence in a note, a
            captured link, or a date on the calendar — it&apos;s the same task everywhere, never
            re-entered.
          </Text>

          <Text style={styles.paragraph}>
            If your task flow has a step this misses, reply and tell me how a task is born in your
            day. That&apos;s exactly what I want to get right before launch.
          </Text>

          <Text style={styles.signature}>
            — Kaan
            <br />
            <Link
              href={trackedMemryUrl('/', WAITLIST_CAMPAIGNS.tasksDeepDive, 'signature')}
              style={styles.signatureLink}
            >
              memrynote.com
            </Link>
          </Text>

          <Hr style={styles.hr} />

          <Text style={styles.footer}>
            You&apos;re getting this because you joined the MemryNote waitlist. Reply to me at{' '}
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
  placeholderLabel
}: {
  url: string
  alt: string
  placeholderLabel: string
}) {
  if (url) {
    return (
      <>
        <Link href={url} target="_blank">
          <Img src={url} alt={alt} width="640" height="412" style={styles.image} />
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

WaitlistTasksDeepDiveEmail.PreviewProps = defaultProps

export default WaitlistTasksDeepDiveEmail

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
