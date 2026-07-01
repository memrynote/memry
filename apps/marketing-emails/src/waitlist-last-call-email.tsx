import type { CSSProperties, ReactElement } from 'react'
import { Body, Button, Container, Head, Hr, Html, Link, Preview, Text } from 'react-email'
import { trackedMemryUrl, WAITLIST_CAMPAIGNS } from './tracking-links'

export const waitlistLastCallContent = {
  subject: 'Your Memrynote waitlist code expires tonight',
  preview: 'Last reminder for the waitlist annual discount.'
} as const

export type WaitlistLastCallEmailProps = {
  firstName?: string
  daysLeft?: string
  discountCode?: string
  discountExpiry?: string
  checkoutUrl?: string
  replyToEmail?: string
  unsubscribeUrl?: string
}

const defaultProps = {
  firstName: '',
  daysLeft: 'tonight',
  discountCode: 'WAITLIST25',
  discountExpiry: 'July 21',
  checkoutUrl: trackedMemryUrl('/sync', WAITLIST_CAMPAIGNS.lastCall, 'discount_cta'),
  replyToEmail: 'kaan@memrynote.com',
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<WaitlistLastCallEmailProps>

type EmailComponent = {
  (props: WaitlistLastCallEmailProps): ReactElement
  PreviewProps?: WaitlistLastCallEmailProps
}

export const WaitlistLastCallEmail: EmailComponent = (props) => {
  const {
    firstName,
    daysLeft,
    discountCode,
    discountExpiry,
    checkoutUrl,
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
      <Preview>{waitlistLastCallContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.paragraph}>{greeting}</Text>

          <Text style={styles.paragraph}>Your Memrynote waitlist code expires in {daysLeft}.</Text>

          <Text style={styles.paragraph}>
            <span style={styles.inlineCode}>{discountCode}</span> — 25% off Memrynote Sync annual,
            lifetime renewals.
          </Text>

          <Text style={styles.paragraph}>After {discountExpiry}, the code is gone.</Text>

          <Button href={checkoutUrl} style={styles.button}>
            Claim 25% off Sync
          </Button>

          <Text style={styles.paragraph}>
            If Memrynote isn&apos;t for you, no hard feelings. Reply and tell me what&apos;s missing
            — I read every one.
          </Text>

          <Text style={styles.signature}>
            — Kaan
            <br />
            <Link
              href={trackedMemryUrl('/', WAITLIST_CAMPAIGNS.lastCall, 'signature')}
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

WaitlistLastCallEmail.PreviewProps = defaultProps

export default WaitlistLastCallEmail

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
  inlineCode: {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontWeight: 700,
    fontSize: '15px',
    color: '#1a1a1a'
  },
  button: {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    margin: '8px 0 28px',
    padding: '14px 20px',
    borderRadius: '8px',
    backgroundColor: '#1a1a1a',
    color: '#ffffff',
    fontSize: '16px',
    fontWeight: 600,
    lineHeight: '20px',
    textAlign: 'center',
    textDecoration: 'none'
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
