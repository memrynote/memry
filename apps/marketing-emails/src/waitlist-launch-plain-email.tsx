import type { CSSProperties, ReactElement } from 'react'
import { Body, Container, Head, Hr, Html, Link, Preview, Text } from 'react-email'
import { trackedMemryUrl, WAITLIST_CAMPAIGNS } from './tracking-links'

export const waitlistLaunchPlainContent = {
  subject: 'MemryNote ships end of June',
  preview: '6 weeks out. Here is the plan.'
} as const

export type WaitlistLaunchPlainEmailProps = {
  firstName?: string
  replyToEmail?: string
  unsubscribeUrl?: string
}

const defaultProps = {
  firstName: '',
  replyToEmail: 'kaan@memrynote.com',
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<WaitlistLaunchPlainEmailProps>

type EmailComponent = {
  (props: WaitlistLaunchPlainEmailProps): ReactElement
  PreviewProps?: WaitlistLaunchPlainEmailProps
}

export const WaitlistLaunchPlainEmail: EmailComponent = (props) => {
  const { firstName, replyToEmail, unsubscribeUrl } = {
    ...defaultProps,
    ...props
  }

  const greeting = firstName ? `Hey ${firstName},` : 'Hey,'

  return (
    <Html lang="en">
      <Head />
      <Preview>{waitlistLaunchPlainContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.paragraph}>{greeting}</Text>

          <Text style={styles.paragraph}>
            Thanks for joining the MemryNote waitlist. Quick update: we&apos;re shipping end of
            June.
          </Text>

          <Text style={styles.paragraph}>
            MemryNote is the notes app I wanted but couldn&apos;t find. Local-first, end-to-end
            encrypted, your data stays on your machine. Optional sync across devices if you want it.
          </Text>

          <Text style={styles.paragraph}>
            I&apos;ll send a few more emails between now and launch:
          </Text>

          <Text style={styles.listItem}>— A look at what we built, with screenshots</Text>
          <Text style={styles.listItem}>— Early access details for waitlist folks</Text>
          <Text style={styles.listItem}>— Launch day, with a perk for being on this list</Text>

          <Text style={styles.paragraphAfterList}>
            That&apos;s it for today. Hit reply if you have questions or if there&apos;s a specific
            thing you want MemryNote to do. I read every reply.
          </Text>

          <Text style={styles.signature}>
            — Kaan
            <br />
            <Link
              href={trackedMemryUrl('/', WAITLIST_CAMPAIGNS.launchPlain, 'signature')}
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

WaitlistLaunchPlainEmail.PreviewProps = defaultProps

export default WaitlistLaunchPlainEmail

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
