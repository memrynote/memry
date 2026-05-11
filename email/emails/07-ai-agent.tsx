import { Heading, Text } from '@react-email/components'
import { Eyebrow } from '../components/Eyebrow'
import { Footer } from '../components/Footer'
import { HeroImage } from '../components/HeroImage'
import { InlineImage } from '../components/InlineImage'
import { Layout } from '../components/Layout'
import { Signoff } from '../components/Signoff'
import { TOTAL_EMAILS, WAITLIST_FIRST_NAME } from '../components/constants'
import { body, greeting, heading, sectionHeading, subhead } from '../components/styles'

export const subject = 'Talk to an AI without giving up your data'
export const preview = 'Pick your model. Your notes stay yours.'

export default function Email07AiAgent() {
  return (
    <Layout preview={preview}>
      <Eyebrow label="AI AGENT" index={7} total={TOTAL_EMAILS} />
      <Heading style={heading}>Talk to an AI without giving up your data.</Heading>
      <Text style={subhead}>Pick your model. Your notes stay yours.</Text>

      <Text style={greeting}>Hi {WAITLIST_FIRST_NAME},</Text>

      <Text style={body}>
        Memry includes an AI agent. You can ask it to draft, summarize, search, or restructure. The
        agent has access to your notes when you give it permission. Otherwise it does not.
      </Text>

      <HeroImage
        alt="AI chat panel open next to a note"
        caption="The AI agent works in a side panel next to whatever you are editing."
      />

      <Heading as="h2" style={sectionHeading}>
        Bring your own model
      </Heading>
      <Text style={body}>
        You choose the provider. Claude, GPT, Gemini, or a local model running on your machine. You
        paste in your own API key. Memry routes the request. Your usage is yours and your bill is
        yours.
      </Text>

      <InlineImage alt="Model picker dropdown with Claude, GPT, Gemini, local model options" />

      <Heading as="h2" style={sectionHeading}>
        What it can do
      </Heading>
      <Text style={body}>
        Ask it to summarize your week from your journal. Ask it to find every task you wrote in
        Italian. Ask it to rewrite a paragraph in a different tone. Ask it to pull every mention of
        a person across every note.
      </Text>

      <Text style={body}>
        The agent runs against the same database you write to. It does not see anything you have not
        encrypted with the same key. When you sign out, the agent loses its memory of you.
      </Text>

      <Signoff launchLine="Launching in 2 weeks." />
      <Footer />
    </Layout>
  )
}

Email07AiAgent.PreviewProps = {}
