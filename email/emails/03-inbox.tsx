import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { InlineImage } from '../components/InlineImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, sectionHeading, subhead } from '../components/styles'

export const subject = 'A faster way to capture'
export const preview = 'Inbox is where ideas land before they find a home.'

export default function Email03Inbox() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="INBOX" index={3} total={TOTAL_EMAILS} />
      <Heading style={heading}>A faster way to capture.</Heading>
      <Text style={subhead}>Drop the thought. Sort it later.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        You think of something. You open Memry. You write it down. The whole loop takes four
        seconds.
      </Text>

      <HeroImage
        alt="Inbox view with several captured items"
        caption="The Inbox holds unstructured thoughts until you are ready to sort them."
      />

      <Text style={body}>
        Inbox is the front door for unstructured thinking. Anything you capture lands there with no
        required tags, no destination folder, no project picker. You can sort later when the day
        allows.
      </Text>

      <Heading as="h2" style={sectionHeading}>
        When the inbox helps
      </Heading>
      <Text style={body}>
        Sometimes the thought is a task that belongs in a project. Sometimes it is a note that
        belongs nowhere yet. Sometimes it is a sentence you will paste into a journal entry tonight.
        Inbox holds all three the same way.
      </Text>

      <InlineImage alt="Converting an inbox item into a task or a note" />

      <Text style={body}>
        We watched ourselves abandon every previous system around the same step: deciding where
        something goes before we know what it is. So Inbox does that step for you. It just holds the
        thing until you decide.
      </Text>

      <Signoff launchLine="Launching in 6 weeks." />
      <Footer />
    </Layout>
  )
}

Email03Inbox.PreviewProps = {}
