import type { CSSProperties, ReactElement } from 'react'
import { Body, Container, Head, Hr, Html, Img, Link, Preview, Section, Text } from 'react-email'
import { trackedMemryUrl, WAITLIST_CAMPAIGNS } from './tracking-links'

export const waitlistProductPreviewContent = {
  subject: 'what MemryNote actually looks like',
  preview: 'The editor, the local-first foundation, and a question for you.'
} as const

export type WaitlistProductPreviewEmailProps = {
  firstName?: string
  screenshotUrl?: string
  replyToEmail?: string
  unsubscribeUrl?: string
}

const defaultProps = {
  firstName: '',
  screenshotUrl: '',
  replyToEmail: 'kaan@memrynote.com',
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<WaitlistProductPreviewEmailProps>

type EmailComponent = {
  (props: WaitlistProductPreviewEmailProps): ReactElement
  PreviewProps?: WaitlistProductPreviewEmailProps
}

export const WaitlistProductPreviewEmail: EmailComponent = (props) => {
  const { firstName, screenshotUrl, replyToEmail, unsubscribeUrl } = {
    ...defaultProps,
    ...props
  }

  const greeting = firstName ? `Hey ${firstName},` : 'Hey,'

  return (
    <Html lang="en">
      <Head />
      <Preview>{waitlistProductPreviewContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.paragraph}>{greeting}</Text>

          <Text style={styles.paragraph}>
            MemryNote launches at the end of June. This week I want to show the editor.
          </Text>

          <Text style={styles.paragraph}>Here&apos;s what the editor looks like:</Text>

          <Screenshot url={screenshotUrl} />

          <Text style={styles.paragraph}>It&apos;s a markdown editor with a few opinions:</Text>

          <Text style={styles.listItem}>
            — Local-first. Your notes live on your machine, not in a vendor cloud.
          </Text>
          <Text style={styles.listItem}>
            — End-to-end encrypted (XChaCha20). Even with sync on, the server never sees plaintext.
          </Text>
          <Text style={styles.listItem}>
            — Works offline. Always. No &quot;reconnecting...&quot; spinners.
          </Text>

          <Text style={styles.paragraphAfterList}>
            That&apos;s the whole pitch. No new file format, no lock-in, no telemetry, no AI
            training data going anywhere.
          </Text>

          <Text style={styles.paragraph}>
            If there&apos;s one part you want to see before launch — tasks, the daily journal, the
            graph, the agent — hit reply with which one. I&apos;ll write the next email about
            whatever the most people ask for.
          </Text>

          <Text style={styles.signature}>
            — Kaan
            <br />
            <Link
              href={trackedMemryUrl('/', WAITLIST_CAMPAIGNS.productPreview, 'signature')}
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

function Screenshot({ url }: { url: string }) {
  if (url) {
    return (
      <Img
        src={url}
        alt="The MemryNote editor with a real note open"
        width="560"
        height="360"
        style={styles.image}
      />
    )
  }

  return (
    <Section style={styles.placeholder}>
      <Text style={styles.placeholderLabel}>
        Screenshot of the MemryNote editor with a real note open
      </Text>
      <Text style={styles.placeholderHint}>
        560×360 hosted PNG or JPG, under 200KB. Replace before sending.
      </Text>
    </Section>
  )
}

WaitlistProductPreviewEmail.PreviewProps = defaultProps

export default WaitlistProductPreviewEmail

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
    maxWidth: '560px',
    margin: '0 auto',
    padding: '40px 24px'
  },
  paragraph: {
    margin: '0 0 20px',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px'
  },
  listItem: {
    margin: '0 0 6px',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px'
  },
  paragraphAfterList: {
    margin: '20px 0',
    color: '#1a1a1a',
    fontSize: '16px',
    lineHeight: '26px'
  },
  image: {
    display: 'block',
    width: '100%',
    maxWidth: '560px',
    height: 'auto',
    margin: '12px 0 28px',
    border: '1px solid #e8e8e8',
    borderRadius: '6px'
  },
  placeholder: {
    margin: '12px 0 28px',
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
