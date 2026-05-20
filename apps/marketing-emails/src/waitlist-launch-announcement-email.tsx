import type { CSSProperties, ReactElement } from 'react'
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
import { waitlistLaunchAnnouncementContent } from './campaign-content'
import { trackedMemryUrl, WAITLIST_CAMPAIGNS } from './tracking-links'

export type WaitlistLaunchAnnouncementEmailProps = {
  firstName?: string
  brandIconUrl?: string
  launchWindow?: string
  discountLabel?: string
  waitlistCount?: string
  heroImageUrl?: string
  landingPageUrl?: string
  replyToEmail?: string
  unsubscribeUrl?: string
}

type EmailComponent = {
  (props: WaitlistLaunchAnnouncementEmailProps): ReactElement
  PreviewProps?: WaitlistLaunchAnnouncementEmailProps
}

const defaultProps = {
  firstName: '',
  brandIconUrl: waitlistLaunchAnnouncementContent.defaultBrandIconUrl,
  launchWindow: waitlistLaunchAnnouncementContent.defaultLaunchWindow,
  discountLabel: waitlistLaunchAnnouncementContent.defaultDiscountLabel,
  waitlistCount: waitlistLaunchAnnouncementContent.defaultWaitlistCount,
  heroImageUrl: '',
  landingPageUrl: trackedMemryUrl('/', WAITLIST_CAMPAIGNS.launchPlain, 'primary_cta'),
  replyToEmail: 'kaan@memrynote.com',
  unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}'
} satisfies Required<WaitlistLaunchAnnouncementEmailProps>

export const WaitlistLaunchAnnouncementEmail: EmailComponent = (props) => {
  const {
    firstName,
    brandIconUrl,
    launchWindow,
    discountLabel,
    waitlistCount,
    heroImageUrl,
    landingPageUrl,
    replyToEmail,
    unsubscribeUrl
  } = {
    ...defaultProps,
    ...props
  }

  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'

  return (
    <Html lang="en">
      <Head />
      <Preview>{waitlistLaunchAnnouncementContent.preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.brandRow}>
            <Img
              src={brandIconUrl}
              alt="MemryNote"
              width="32"
              height="32"
              style={styles.brandIcon}
            />
            <Text style={styles.brandName}>{waitlistLaunchAnnouncementContent.brandName}</Text>
          </Section>

          <Text style={styles.eyebrow}>{waitlistLaunchAnnouncementContent.eyebrow}</Text>
          <Heading style={styles.heading}>{waitlistLaunchAnnouncementContent.heading}</Heading>

          <Text style={styles.paragraph}>{greeting}</Text>
          <Text style={styles.paragraph}>
            You joined the MemryNote waitlist, so I wanted to send a short note: MemryNote launches
            at the {launchWindow}.
          </Text>
          <Text style={styles.paragraph}>
            I am building it for people who are tired of splitting their thinking across notes,
            tasks, inboxes, calendars, and journals. MemryNote keeps those pieces in one local-first
            workspace, with AI available when it helps.
          </Text>

          <MediaSlot imageUrl={heroImageUrl} />

          <Section style={styles.callout}>
            <Text style={styles.calloutLabel}>Waitlist thank-you</Text>
            <Text style={styles.calloutText}>
              There are {waitlistCount} people on the list right now. On launch day, waitlist
              members get {discountLabel}. I will send the link when checkout opens.
            </Text>
          </Section>

          <Text style={styles.paragraph}>
            Over the next few weeks, I will send short updates showing the core parts of MemryNote:
            inbox, notes, tasks, journal, calendar, and the agent.
          </Text>
          <Text style={styles.paragraph}>
            One useful thing you can do now: reply and tell me what you hope MemryNote replaces for
            you. I read every reply.
          </Text>

          <Button href={landingPageUrl} style={styles.button}>
            {waitlistLaunchAnnouncementContent.primaryCta}
          </Button>

          <Text style={styles.signature}>
            Kaan
            <br />
            Founder, MemryNote
          </Text>

          <Hr style={styles.hr} />
          <Text style={styles.footer}>
            You are receiving this because you joined the MemryNote waitlist. Reply directly at{' '}
            <Link href={`mailto:${replyToEmail}`} style={styles.footerLink}>
              {replyToEmail}
            </Link>
            .{' '}
            <Link href={unsubscribeUrl} style={styles.footerLink}>
              Unsubscribe
            </Link>
            .
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

function MediaSlot({ imageUrl }: { imageUrl: string }) {
  if (imageUrl) {
    return (
      <Img
        src={imageUrl}
        alt="MemryNote product preview"
        width="560"
        height="355"
        style={styles.image}
      />
    )
  }

  return (
    <Section style={styles.placeholder}>
      <Text style={styles.placeholderLabel}>
        {waitlistLaunchAnnouncementContent.heroPlaceholder}
      </Text>
      <Text style={styles.placeholderHint}>{waitlistLaunchAnnouncementContent.heroHint}</Text>
    </Section>
  )
}

WaitlistLaunchAnnouncementEmail.PreviewProps = defaultProps

export default WaitlistLaunchAnnouncementEmail

const styles = {
  body: {
    margin: 0,
    backgroundColor: '#f6f1e8',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif',
    color: '#24211d'
  },
  container: {
    width: '100%',
    maxWidth: '600px',
    margin: '0 auto',
    padding: '40px 20px'
  },
  brandRow: {
    margin: '0 0 28px',
    lineHeight: '32px'
  },
  brandIcon: {
    display: 'inline-block',
    width: '32px',
    height: '32px',
    margin: '0 10px 0 0',
    verticalAlign: 'middle'
  },
  brandName: {
    display: 'inline-block',
    margin: 0,
    color: '#24211d',
    fontSize: '17px',
    lineHeight: '32px',
    fontWeight: 750,
    verticalAlign: 'middle'
  },
  eyebrow: {
    margin: '0 0 12px',
    color: '#7a5b35',
    fontSize: '13px',
    fontWeight: 700,
    letterSpacing: '0.4px',
    textTransform: 'uppercase'
  },
  heading: {
    margin: '0 0 28px',
    color: '#1f1b16',
    fontSize: '34px',
    lineHeight: '40px',
    fontWeight: 750
  },
  paragraph: {
    margin: '0 0 18px',
    color: '#39342d',
    fontSize: '16px',
    lineHeight: '26px'
  },
  placeholder: {
    margin: '30px 0',
    padding: '42px 28px',
    border: '1px dashed #b99a6b',
    borderRadius: '8px',
    backgroundColor: '#fbf7ef',
    textAlign: 'center'
  },
  placeholderLabel: {
    margin: '0 0 8px',
    color: '#4d4337',
    fontSize: '15px',
    lineHeight: '22px',
    fontWeight: 700
  },
  placeholderHint: {
    margin: 0,
    color: '#7f7163',
    fontSize: '13px',
    lineHeight: '20px'
  },
  image: {
    width: '100%',
    maxWidth: '560px',
    height: 'auto',
    margin: '30px 0',
    borderRadius: '8px',
    border: '1px solid #e4d8c8'
  },
  callout: {
    margin: '28px 0',
    padding: '20px',
    border: '1px solid #e3d2bc',
    borderRadius: '8px',
    backgroundColor: '#fffaf2'
  },
  calloutLabel: {
    margin: '0 0 8px',
    color: '#7a4f17',
    fontSize: '13px',
    lineHeight: '18px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.3px'
  },
  calloutText: {
    margin: 0,
    color: '#3d352c',
    fontSize: '15px',
    lineHeight: '24px'
  },
  button: {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    margin: '28px 0',
    padding: '14px 20px',
    borderRadius: '8px',
    backgroundColor: '#24211d',
    color: '#ffffff',
    fontSize: '15px',
    fontWeight: 700,
    lineHeight: '20px',
    textAlign: 'center',
    textDecoration: 'none'
  },
  signature: {
    margin: '0 0 28px',
    color: '#39342d',
    fontSize: '16px',
    lineHeight: '25px'
  },
  hr: {
    margin: '0 0 18px',
    borderColor: '#ded2c2'
  },
  footer: {
    margin: 0,
    color: '#877a6a',
    fontSize: '12px',
    lineHeight: '19px'
  },
  footerLink: {
    color: '#5f4529',
    textDecoration: 'underline'
  }
} satisfies Record<string, CSSProperties>
