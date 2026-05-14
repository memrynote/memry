import { LegalLayout } from '@/components/shared/LegalLayout'
import { PageHead } from '@/components/shared/PageHead'

export function RefundPage() {
  return (
    <>
      <PageHead page="refund" />
      <LegalLayout
        eyebrow="Legal · Refunds"
        title="Refund Policy"
        intro="Seven days to change your mind on any paid plan, including Believer. No questions asked."
        lastUpdated="May 9, 2026"
      >
        <h2>The short version</h2>
        <ul>
          <li>
            <strong>7-day money-back guarantee</strong> on every paid Sync plan — Plus, Pro, and
            Believer.
          </li>
          <li>
            Request a refund inside the app or email{' '}
            <a href="mailto:billing@memrynote.com">billing@memrynote.com</a> from the account
            address.
          </li>
          <li>
            Paddle, our merchant of record, returns the money to your original payment method.
          </li>
          <li>
            After day 7 we honour refunds case-by-case for genuine billing problems and duplicate
            charges.
          </li>
        </ul>

        <h2>1. The 7-day guarantee</h2>
        <p>
          Every paid plan comes with a 7-day money-back guarantee, counted from the moment you first
          complete a paid checkout. If Memry isn&apos;t for you in that window, ask for a refund and
          we will issue it without questions.
        </p>
        <p>
          The guarantee covers your first paid period only. Renewals (the second month, the second
          year, and so on) are not eligible — see the section on renewals below.
        </p>

        <h2>2. Believer (lifetime) refunds</h2>
        <p>
          The Believer tier — a one-time supporter package — is also covered by the 7-day guarantee.
          If you change your mind in the first week, ask for a refund and we will process it the
          same way as any other plan.
        </p>
        <p>
          After day 7, Believer is non-refundable. The whole point of the tier is a long-term bet in
          both directions: you commit to us, we commit to you, and the price funds the next chapter
          of the product.
        </p>

        <h2>3. How to request a refund</h2>
        <p>You have two equivalent paths:</p>
        <ul>
          <li>
            <strong>Inside the app:</strong> Settings → Billing → Request a refund. The button opens
            a Paddle-hosted form. We get a copy automatically.
          </li>
          <li>
            <strong>Email:</strong> send a message from the address on your account to{' '}
            <a href="mailto:billing@memrynote.com">billing@memrynote.com</a> with the subject
            &ldquo;Refund request.&rdquo; Mention which plan you bought and we will take it from
            there.
          </li>
        </ul>
        <p>
          You do not need to explain why. We may ask for short feedback so we can make the product
          better, but answering is always optional.
        </p>

        <h2>4. How long it takes</h2>
        <ul>
          <li>
            <strong>We process the request</strong> within two business days of receiving it.
          </li>
          <li>
            <strong>Paddle issues the refund</strong> back to your original payment method within
            5–10 business days, depending on your bank or card network.
          </li>
          <li>
            <strong>Sync access ends</strong> as soon as the refund is processed. Your local app and
            vault remain yours; the lapse policy then applies as if the subscription had ended.
          </li>
        </ul>

        <h2>5. Renewals</h2>
        <p>
          We do not refund renewal charges by default — you have unlimited time to cancel before the
          next renewal hits. We send a reminder email seven days before each annual renewal so there
          are no surprise charges.
        </p>
        <p>
          If a renewal slipped through and you genuinely had not used Sync during the new period,
          email us within 14 days of the charge and we will issue a one-time goodwill refund. We
          look at usage rather than the calendar — the goal is to be fair.
        </p>

        <h2>6. Plan changes</h2>
        <ul>
          <li>
            <strong>Upgrades</strong> are pro-rated immediately. You pay only the difference for the
            remainder of the current period.
          </li>
          <li>
            <strong>Downgrades</strong> take effect at the end of the current billing period.
            Existing data above the new tier&apos;s limits stays readable while you decide what to
            archive.
          </li>
        </ul>

        <h2>7. Refunds we cannot give</h2>
        <p>We will decline a refund if:</p>
        <ul>
          <li>
            The 7-day window has closed and the charge in question is not a duplicate, fraudulent,
            or otherwise erroneous transaction.
          </li>
          <li>
            The account has been suspended for violating the <a href="/terms">Terms of Service</a>,
            especially around abuse or attempted fraud.
          </li>
          <li>
            The request comes from someone other than the account owner. Refunds go back to the card
            or wallet that paid.
          </li>
        </ul>

        <h2>8. Statutory rights</h2>
        <p>
          Nothing in this policy reduces the legal rights you have where you live. If the law in
          your country gives you a longer cooling-off period or stronger consumer protections, those
          win — tell us in your refund request and we will follow them.
        </p>

        <h2>9. Chargebacks</h2>
        <p>
          Please reach out before filing a chargeback with your bank. We have never said no to a
          good-faith refund request, and a direct conversation is faster than a dispute. Accounts
          with active chargebacks are paused while Paddle investigates.
        </p>

        <h2>10. Contact</h2>
        <p>
          Billing questions: <a href="mailto:billing@memrynote.com">billing@memrynote.com</a>.
          Everything else: <a href="mailto:hi@memrynote.com">hi@memrynote.com</a>.
        </p>
      </LegalLayout>
    </>
  )
}
