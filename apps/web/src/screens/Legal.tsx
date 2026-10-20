import type { ReactNode } from 'react';

/** Effective date and version shown on both documents. Keep in step with TERMS_VERSION in the API. */
export const LEGAL_EFFECTIVE = 'October 17, 2026';
export const CONTACT_EMAIL = 'support@mahoul.io';

function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="wrap legal">
      <header className="bar">
        <a className="brand" href="/" style={{ textDecoration: 'none' }}>
          <span className="ball">⚽</span>
          <div>
            <h1>Lineup</h1>
            <span className="sub">{title}</span>
          </div>
        </a>
      </header>
      <article className="card legal-doc">
        <h2>{title}</h2>
        <p className="note">Effective {LEGAL_EFFECTIVE}</p>
        {children}
        <p className="note legal-links">
          <a href="/terms">Terms of Use</a> · <a href="/privacy">Privacy Policy</a> · <a href="/">Back to Lineup</a>
        </p>
      </article>
    </main>
  );
}

export function TermsOfUse() {
  return (
    <LegalShell title="Terms of Use (End User License Agreement)">
      <TermsBody />
    </LegalShell>
  );
}

/** The Terms text, also shown in the box people scroll through before accepting. */
export function TermsBody() {
  return (
    <>
      <p>
        These Terms of Use (the "Terms") are an agreement between you and mahoul.io ("we", "us")
        for the Lineup website at lineup.mahoul.io and the Lineup mobile app (together, the
        "Service"). By creating an account or using the Service you agree to these Terms and to our{' '}
        <a href="/privacy">Privacy Policy</a>. If you do not agree, do not use the Service.
      </p>

      <h3>1. You must be 18 or older</h3>
      <p>
        <strong>The Service is for adults only.</strong> You must be at least 18 years old to create an
        account, sign in or use the Service. By using it you confirm that you are 18 or older. The
        Service is a tool for coaches, team administrators, parents and guardians. It is not
        directed to children, and children may not create accounts.
      </p>

      <h3>2. The Service is supported by advertising</h3>
      <p>
        <strong>The Service shows advertising.</strong> Ads may appear on the website and in the mobile
        app, and are supplied by third parties including Google (Google AdSense on the web and Google
        AdMob in the app). Free use of the Service is supported by these ads. We may reduce or remove
        ads for paid plans, but we do not promise an ad-free experience unless a plan says so. We do
        not control and are not responsible for the content of third-party ads or the websites they
        link to. How ads use data is described in the <a href="/privacy">Privacy Policy</a>.
      </p>

      <h3>3. Your account</h3>
      <p>
        You are responsible for your account, for keeping your sign-in details secure and for
        everything done through your account. Give accurate information and keep it current. Tell us
        promptly if you think your account has been used without permission.
      </p>

      <h3>4. Team and player information you add</h3>
      <p>
        You may add information about teams and players, including youth players, such as names,
        shirt numbers, positions, availability, attendance and match statistics. You confirm that you
        have the right to add it, including any permission needed from a player's parent or guardian,
        and that you will use it only to run your team. Keep it to what is needed. You keep ownership
        of what you add, and you give us a limited licence to store, process and display it to the
        people you choose to share it with, solely to provide the Service.
      </p>

      <h3>5. Acceptable use</h3>
      <p>You agree not to:</p>
      <ul>
        <li>use the Service for anything unlawful, harmful, harassing or abusive;</li>
        <li>add information you have no right to share, or misuse anyone's personal information;</li>
        <li>attempt to access accounts, teams or data that are not yours;</li>
        <li>interfere with, overload, probe or reverse engineer the Service, except where the law allows;</li>
        <li>
          click your own ads, generate artificial ad traffic or encourage others to click ads, or
          otherwise interfere with advertising;
        </li>
        <li>resell, copy or build a competing product from the Service.</li>
      </ul>
      <p>
        <strong>Team chat.</strong> Each team has a chat for everyone on the team, one for staff and one
        for coaches, and only people in a chat see its messages. Organization and region staff of a team
        can join its chats; everyone in the chat sees when they join and leave. You are responsible for
        what you post. Be respectful, and do not share personal information about children beyond what
        the team needs. Messages are deleted automatically after 90 days.
      </p>

      <h3>6. Paid plans</h3>
      <p>
        Some features need a paid plan. Plans are billed in advance for each billing period and
        renew automatically until cancelled. You can cancel at any time; access continues until the
        end of the period you paid for, then the account returns to the free plan without deleting
        your data. Except where the law requires, payments are not refundable. We may change prices
        for future periods with notice.
      </p>
      <p>
        <strong>Free trials.</strong> Organizations and regions can try their plan free for 30 days,
        and coaches can try the Coach plan free for 7 days. No payment card is needed to start a
        trial. The person who starts an organization or region trial is its director and can invite
        admins under the same trial. If a trial ends without a subscription, the organization or
        region and everyone invited to it lose access. The director can switch to a free coach
        account and start again. Trial data is kept for 30 days after the trial ends so it can be
        restored on subscription, then it may be deleted. Free accounts with no activity for a year
        may be archived.
      </p>

      <h3>7. Mobile app licence</h3>
      <p>
        We grant you a personal, limited, non-exclusive, non-transferable and revocable licence to
        install and use the Lineup app on devices you own or control, for your own use under these
        Terms. You may not copy, modify, distribute, sell or lease the app, or remove any notices from
        it. The terms of the app store you download it from also apply; if they conflict with these
        Terms on how the store itself is used, the store's terms apply.
      </p>

      <h3>8. Third-party services</h3>
      <p>
        The Service relies on third parties, such as hosting, sign-in, email and advertising
        providers. Their services are governed by their own terms, and we are not responsible for
        them.
      </p>

      <h3>9. Suspension and termination</h3>
      <p>
        You can stop using the Service at any time. From Account you can deactivate your account:
        you can't use it while it is deactivated, and we keep it for one year so you can sign in and
        reactivate it. After that year it is deleted permanently. You can instead ask for permanent
        deletion straight away, which runs after a 7-day grace period you can cancel. We may
        suspend or end access if you break these Terms, if required by law, or to protect users or
        the Service.
      </p>

      <h3>10. Disclaimers</h3>
      <p>
        The Service is provided "as is" and "as available". To the extent the law allows, we make no
        warranties of any kind, including that the Service will be uninterrupted, error-free or fit
        for a particular purpose. Line-ups, playing-time and statistics are aids to your own
        judgement; you remain responsible for decisions about your team and players.
      </p>

      <h3>11. Limitation of liability</h3>
      <p>
        To the extent the law allows, we are not liable for indirect, incidental, special,
        consequential or punitive damages, or for lost data, profits or goodwill. Our total liability
        for any claim about the Service is limited to the greater of the amount you paid us in the 12
        months before the claim or US$50. Some places do not allow these limits, so they may not all
        apply to you.
      </p>

      <h3>12. Indemnity</h3>
      <p>
        You agree to defend and indemnify us against claims arising from information you add, your
        use of the Service or your breach of these Terms.
      </p>

      <h3>13. Governing law</h3>
      <p>
        These Terms are governed by the laws of the State of California, USA, without regard to its
        conflict-of-law rules. Courts located in California have jurisdiction, except where the law
        of your place of residence gives you the right to bring a claim locally.
      </p>

      <h3>14. Changes</h3>
      <p>
        We may update these Terms. When changes are material we will ask you to accept them again in
        the app. Continuing to use the Service after that means you accept the updated Terms.
      </p>

      <h3>15. Contact</h3>
      <p>
        Questions? Use Help &amp; support in the app or email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </>
  );
}

export function PrivacyPolicy() {
  return (
    <LegalShell title="Privacy Policy">
      <PrivacyBody />
    </LegalShell>
  );
}

/** The Privacy Policy text, also shown in the box before accepting. */
export function PrivacyBody() {
  return (
    <>
      <p>
        This policy explains what information Lineup (the website at lineup.mahoul.io and the Lineup
        mobile app, the "Service") collects, how it is used and the choices you have. The Service is
        operated by mahoul.io ("we", "us").
      </p>

      <h3>1. Who the Service is for</h3>
      <p>
        The Service is for adults aged 18 and over, such as coaches, team administrators, parents and
        guardians. It is not directed to children, and we do not knowingly let anyone under 18 create
        an account. Adults may add limited information about youth players to run a team, as
        described below.
      </p>

      <h3>2. Information we collect</h3>
      <ul>
        <li>
          <strong>Account information:</strong> your display name and the email address from your
          sign-in, handled by Microsoft Entra External ID. We do not see or store your password.
        </li>
        <li>
          <strong>Team and player information you add:</strong> team names and logos, player names,
          shirt numbers, positions, availability, attendance, line-ups, match events, statistics and
          notes, plus the organizations, regions and schedules you set up.
        </li>
        <li>
          <strong>Invitations:</strong> the email address of anyone you invite and the role you give
          them.
        </li>
        <li>
          <strong>Support requests:</strong> what you write to us through Help &amp; support.
        </li>
        <li>
          <strong>Usage and security data:</strong> when you use the Service, the pages and features
          used, and a salted one-way hash of your IP address (never the address itself). We use
          these to keep the Service secure, prevent abuse and understand how it is used.
        </li>
        <li>
          <strong>Cookies and device identifiers:</strong> a cookie keeps you signed in. Advertising
          partners may set cookies or read device identifiers, as described in section 4.
        </li>
      </ul>

      <h3>3. How we use information</h3>
      <ul>
        <li>to provide the Service: sign-in, team management, line-ups, match day, stats and sharing;</li>
        <li>to send invitations and service messages;</li>
        <li>to respond to support requests;</li>
        <li>to secure the Service, prevent fraud and abuse, and fix problems;</li>
        <li>to understand usage and improve the Service;</li>
        <li>to show advertising that funds the free Service;</li>
        <li>to meet legal obligations.</li>
      </ul>
      <p>We do not sell your personal information.</p>

      <h3>4. Advertising</h3>
      <p>
        The Service shows ads from Google: Google AdSense on the website and Google AdMob in the
        mobile app. Google and its partners may use cookies, device advertising identifiers and
        similar technologies to show and measure ads. In the mobile app we request non-personalised
        ads. Where the law requires it, for example in the European Economic Area and the UK, you are
        asked for consent before personalised advertising is used. Learn how Google uses data at{' '}
        <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer">
          policies.google.com/technologies/partner-sites
        </a>
        , and manage ad personalisation at{' '}
        <a href="https://adssettings.google.com" target="_blank" rel="noopener noreferrer">
          adssettings.google.com
        </a>
        . Information about players is never used for advertising.
      </p>

      <h3>5. Youth player information</h3>
      <p>
        Coaches and administrators may add information about youth players to run a team. They are
        responsible for having permission from a parent or guardian. Parents and guardians who join a
        team see only the players linked to them. Links shared outside the app show shortened names
        (first name and last initial) and expire. A parent or guardian can ask the team's coach, or
        us, to correct or remove a player's information, and removing a player deletes their
        records.
      </p>

      <h3>6. Who we share information with</h3>
      <ul>
        <li>
          <strong>People in your teams:</strong> what others see depends on their role, for example
          coaches see their team's roster and parents see only their linked players.
        </li>
        <li>
          <strong>Service providers</strong> who process data for us: Microsoft Azure (hosting and
          database), Microsoft Entra External ID (sign-in), Azure Communication Services (email),
          Google (advertising) and, for paid plans, our payment processor. Card details are handled
          by the payment processor and never stored by us.
        </li>
        <li>
          <strong>Legal reasons:</strong> when required by law or to protect the rights and safety of
          users or the Service.
        </li>
        <li>
          <strong>Business transfers:</strong> if the Service is sold or merged, under this policy.
        </li>
      </ul>

      <h3>7. Your choices and rights</h3>
      <ul>
        <li>export a full copy of a team's data from the app;</li>
        <li>correct or delete teams, games and players;</li>
        <li>
          deactivate your account from Account; it is kept for one year so you can reactivate it by
          signing in, then deleted permanently;
        </li>
        <li>delete your account permanently from Account; deletion runs after a 7-day grace period you can cancel;</li>
        <li>unsubscribe from emails using the link in any email;</li>
        <li>manage ad personalisation through Google's settings above.</li>
      </ul>
      <p>
        Depending on where you live, you may have further rights, such as to access, correct or
        delete your information, or to object to or restrict processing. To use them, contact us
        below. We will not discriminate against you for using your rights.
      </p>

      <h3>8. Retention</h3>
      <p>
        We keep information while your account is active. If you deactivate your account, we keep
        its information for one year so you can reactivate it, then delete it. Deleted teams and
        games are removed from
        the app straight away, and deleted players are removed together with their records. Team
        chat messages are deleted automatically 90 days after they are sent, and your messages are
        deleted with your account. We aim
        to keep request logs no longer than 90 days. We may keep limited records longer where the
        law requires.
      </p>

      <h3>9. Security and storage</h3>
      <p>
        Information is stored in Microsoft Azure data centres in the United States, encrypted in
        transit and at rest. No system is perfectly secure, but we work to protect your information.
      </p>

      <h3>10. Changes</h3>
      <p>
        We may update this policy. When changes are material we will ask you to review them in the
        app.
      </p>

      <h3>11. Contact</h3>
      <p>
        Questions or requests: use Help &amp; support in the app or email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </>
  );
}
