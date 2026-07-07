import { LegalLayout } from '@/components/shared/LegalLayout'
import { PageHead } from '@/components/shared/PageHead'

export function CodeSigningPolicyPage() {
  return (
    <>
      <PageHead page="codeSigning" />
      <LegalLayout
        eyebrow="Legal · Code signing"
        title="Code Signing Policy"
        intro="How memrynote's desktop builds are signed, who approves each release, and how you can verify what you install."
        lastUpdated="July 7, 2026"
      >
        <h2>1. Signing provider</h2>
        <p>Free code signing provided by SignPath.io, certificate by SignPath Foundation.</p>
        <p>
          memrynote&apos;s desktop installers are signed with a certificate issued to SignPath
          Foundation and provided to open-source projects. A valid signature confirms the binary is
          an automated build produced from the source code at{' '}
          <a href="https://github.com/memrynote/memry">github.com/memrynote/memry</a>.
        </p>

        <h2>2. Team roles</h2>
        <p>
          memrynote is maintained by a single developer, who is responsible for every code-signing
          role:
        </p>
        <ul>
          <li>
            <strong>Committers and reviewers:</strong>{' '}
            <a href="https://github.com/memrynote/memry/graphs/contributors">
              memrynote/memry contributors
            </a>
          </li>
          <li>
            <strong>Approvers:</strong> <a href="https://github.com/h4yfans">@h4yfans</a> (repository
            owner)
          </li>
        </ul>
        <p>
          Every change to source code, build scripts, and CI configuration is reviewed before it is
          merged. Every release is approved manually before it is signed.
        </p>

        <h2>3. Security practices</h2>
        <ul>
          <li>
            Multi-factor authentication is enforced on both the source repository (GitHub) and the
            SignPath account.
          </li>
          <li>
            Binaries are built from source in a verifiable, automated CI pipeline. We do not sign
            artifacts built outside that pipeline.
          </li>
          <li>
            We sign only our own binaries, built from our own source. Any third-party or upstream
            binaries bundled in an installer are not signed with this certificate.
          </li>
        </ul>

        <h2>4. Privacy policy</h2>
        <p>
          See our <a href="/privacy">privacy policy</a> for how memrynote handles your data. In
          short: the local app collects nothing, and Sync uploads only ciphertext encrypted on your
          device — keys never touch our servers.
        </p>

        <h2>5. Report a concern</h2>
        <p>
          If you believe a file signed with a SignPath Foundation certificate violates their policy,
          email <a href="mailto:security@memrynote.com">security@memrynote.com</a>, or report it
          directly to SignPath at <a href="mailto:support@signpath.io">support@signpath.io</a>.
        </p>
      </LegalLayout>
    </>
  )
}
