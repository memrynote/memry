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

export const waitlistLaunchDayContent = {
  subject: 'MemryNote is live',
  preview: 'Download link, waitlist code, and a note from me.'
} as const

export type WaitlistLaunchDayEmailProps = {
  firstName?: string
  heroImageUrl?: string
  downloadUrl?: string
  discountCode?: string
  discountExpiry?: string
  replyToEmail?: string
  unsubscribeUrl?: string
}

const defaultProps = {
  firstName: '',
  heroImageUrl: '',
  downloadUrl: trackedMemryUrl('/download/desktop', WAITLIST_CAMPAIGNS.launchDay, 'download_cta'),
  discountCode: 'WAITLIST25',
  discountExpiry: 'July 21',
  replyToEmail: 'kaan@memrynote.com',
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<WaitlistLaunchDayEmailProps>

type EmailComponent = {
  (props: WaitlistLaunchDayEmailProps): ReactElement
  PreviewProps?: WaitlistLaunchDayEmailProps
}

export const WaitlistLaunchDayEmail: EmailComponent = (props) => {
  const {
    firstName,
    heroImageUrl,
    downloadUrl,
    discountCode,
    discountExpiry,
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
      <Preview>{waitlistLaunchDayContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.paragraph}>{greeting}</Text>

          <Text style={styles.paragraph}>MemryNote is live.</Text>

          <Hero url={heroImageUrl} />

          <Text style={styles.paragraph}>The desktop app is free. Download it here:</Text>

          <Button href={downloadUrl} style={styles.button}>
            Download MemryNote
          </Button>

          <Text style={styles.paragraph}>
            Sync across devices is the paid plan. As a waitlist member, you get 25% off MemryNote
            Sync annual — for the life of your subscription — if you claim before {discountExpiry}.
          </Text>

          <Section style={styles.callout}>
            <Text style={styles.calloutLabel}>Your waitlist code</Text>
            <Text style={styles.calloutCode}>{discountCode}</Text>
            <Text style={styles.calloutDetail}>
              25% off MemryNote Sync annual, lifetime renewals.
            </Text>
            <Text style={styles.calloutExpiry}>Expires {discountExpiry}.</Text>
          </Section>

          <Text style={styles.paragraph}>What Sync gets you:</Text>

          <Text style={styles.listItem}>
            — Your notes across every device, end-to-end encrypted.
          </Text>
          <Text style={styles.listItem}>— Unlimited devices.</Text>
          <Text style={styles.listItem}>— First access to anything new I build for Sync.</Text>

          <Text style={styles.paragraphAfterList}>
            If you hit a bug or have questions, hit reply. I&apos;m watching the inbox all day.
          </Text>

          <Text style={styles.paragraph}>Six months of work. Now it&apos;s yours.</Text>

          <Text style={styles.signature}>
            — Kaan
            <br />
            <Link
              href={trackedMemryUrl('/', WAITLIST_CAMPAIGNS.launchDay, 'signature')}
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

function Hero({ url }: { url: string }) {
  if (url) {
    return (
      <Img
        src={url}
        alt="MemryNote running on a desktop — the editor with a real note open"
        width="560"
        height="360"
        style={styles.image}
      />
    )
  }

  return (
    <Section style={styles.placeholder}>
      <Text style={styles.placeholderLabel}>
        Launch hero: MemryNote running on macOS or Windows
      </Text>
      <Text style={styles.placeholderHint}>
        560×360 hosted PNG or JPG, under 200KB. Replace before sending.
      </Text>
    </Section>
  )
}

WaitlistLaunchDayEmail.PreviewProps = defaultProps

export default WaitlistLaunchDayEmail

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
  callout: {
    margin: '12px 0 28px',
    padding: '24px',
    border: '1px solid #e8e8e8',
    borderRadius: '8px',
    backgroundColor: '#fafafa',
    textAlign: 'center'
  },
  calloutLabel: {
    margin: '0 0 8px',
    color: '#555555',
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.6px'
  },
  calloutCode: {
    margin: '0 0 12px',
    color: '#1a1a1a',
    fontSize: '24px',
    lineHeight: '32px',
    fontWeight: 700,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    letterSpacing: '1.5px'
  },
  calloutDetail: {
    margin: '0 0 4px',
    color: '#1a1a1a',
    fontSize: '14px',
    lineHeight: '20px'
  },
  calloutExpiry: {
    margin: 0,
    color: '#888888',
    fontSize: '13px',
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
