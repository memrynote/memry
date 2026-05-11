import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { InlineImage } from '../components/InlineImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, sectionHeading, subhead } from '../components/styles'

export const subject = 'Daily journaling that follows you'
export const preview = 'Pick up the same entry on any device.'

export default function Email05Journal() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="JOURNAL" index={5} total={TOTAL_EMAILS} />
      <Heading style={heading}>Daily journaling that follows you.</Heading>
      <Text style={subhead}>Write at your desk. Finish on your phone.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        Memry has a journal. One entry per day. Markdown body. Frontmatter. Block editor. The same
        surface as your other notes, with a date instead of a title.
      </Text>

      <HeroImage
        alt="Journal view with calendar sidebar"
        caption="The journal sits next to your calendar. Today's entry is one click away."
      />

      <Text style={body}>
        The interesting part is what happens when two devices write to the same day. Most sync
        engines panic. They surface a conflict, ask you to pick a version, or quietly overwrite the
        loser.
      </Text>

      <Heading as="h2" style={sectionHeading}>
        How sync works
      </Heading>
      <Text style={body}>
        Memry uses CRDTs. Conflict-free replicated data types. Two devices can edit the same
        paragraph at the same time, and both edits land. No prompt. No version picker. No lost
        sentence.
      </Text>

      <InlineImage alt="Two devices editing the same journal entry, both edits visible" />

      <Text style={body}>
        It works offline. Write all weekend in a cabin with no signal. When you reconnect, Memry
        catches up in the background. You do not see it happen.
      </Text>

      <Signoff launchLine="Launching in 4 weeks." />
      <Footer />
    </Layout>
  )
}

Email05Journal.PreviewProps = {}
