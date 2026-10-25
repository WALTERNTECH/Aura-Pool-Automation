import { useParams } from "react-router-dom";
import { TopBar } from "../components/ui";
import { t } from "../lib/i18n";
import { useLang } from "../lib/hooks";

// Draft terms and privacy policy, written for the Kenya Data Protection Act 2019. They must be
// reviewed by counsel (including the regulatory position on holding merchants' funds) before launch.

export default function Legal() {
  useLang();
  const { doc } = useParams();
  const terms = doc === "terms";
  return (
    <main className="page bare">
      <TopBar title={terms ? t("legal.terms") : t("legal.privacy")} back={true} />
      <p className="banner info small">{t("legal.draft")}</p>
      <article className="prose" style={{ marginTop: 14 }}>{terms ? <Terms /> : <Privacy />}</article>
    </main>
  );
}

function Terms() {
  return (
    <>
      <p>These terms cover your use of Aura Pool as the owner or attendant of a pay-per-game pool table. By finishing sign-up you accept them.</p>
      <h2>1. The service</h2>
      <p>Aura Pool receives M-Pesa payments for games on your tables, unlocks the table for each paid game, keeps a record of every payment, and pays your earnings to your verified M-Pesa number when you withdraw or on your automatic schedule.</p>
      <h2>2. Your earnings</h2>
      <p>For each paid game you earn the game price less the platform commission shown in the app. Commission changes apply only to payments made after the change. Figures in the app come from our ledger; if you think one is wrong, report it from the payment and we will review it.</p>
      <h2>3. Withdrawals</h2>
      <p>Withdrawals go only to the payout number you verified. A withdrawal fee may apply and is shown before you confirm. Large withdrawals, and withdrawals after a number change, may be held for review. If a withdrawal fails, the amount returns to your balance. We may pause withdrawals to protect funds, for example while checking a suspicious payment.</p>
      <h2>4. Your account</h2>
      <p>Keep your PIN private. You are responsible for what is done with your account and your attendants' accounts. Tell us at once if you think someone else has used it. We may suspend an account that breaks these terms; you can still see your history while suspended.</p>
      <h2>5. Tables and equipment</h2>
      <p>Keep the table powered and connected. A paid game waits for an offline table for a limited time and may then be refunded to the customer. The override button and manual unlocks are recorded and are not counted as paid games.</p>
      <h2>6. Refunds and disputes</h2>
      <p>Customer refunds for failed, unmatched or underpaid games are handled by Aura Pool. Where a refund concerns a game you were credited for, the refunded amount is taken from your balance.</p>
      <h2>7. Changes and ending</h2>
      <p>We will tell you in the app before these terms change. You may close your account at any time once your balance has been paid out.</p>
      <h2>8. Law</h2>
      <p>These terms are governed by the laws of Kenya.</p>
    </>
  );
}

function Privacy() {
  return (
    <>
      <p>Aura Pool processes personal data as a data controller under the Kenya Data Protection Act, 2019.</p>
      <h2>What we collect</h2>
      <p>For owners and attendants: name, phone number, business details, payout number, sign-in records and the devices you use. For customers who pay at a table: the M-Pesa transaction details Safaricom sends us. Customer phone numbers are stored hashed and shown only masked (for example 0712***678); owners never see them in full.</p>
      <h2>Why</h2>
      <p>To run the tables, credit and pay out earnings, prevent fraud, meet legal and accounting duties, and support you.</p>
      <h2>Who we share it with</h2>
      <p>Safaricom (M-Pesa), our SMS and email providers, and our hosting providers, only as needed to deliver the service. We do not sell personal data. Analytics never include personal data.</p>
      <h2>How long</h2>
      <p>Payment and audit records are kept for as long as the law and accounting rules require. Other data is deleted when no longer needed.</p>
      <h2>Your rights</h2>
      <p>You may ask to see, correct or delete your data, or object to its use, by contacting support. You may also complain to the Office of the Data Protection Commissioner.</p>
      <h2>Security</h2>
      <p>Data is encrypted in transit and at rest, access is limited by role, and every sensitive action is logged.</p>
    </>
  );
}
