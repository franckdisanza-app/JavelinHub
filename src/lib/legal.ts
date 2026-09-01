/**
 * =============================================================================
 * The facts the legal pages cannot invent.
 * =============================================================================
 *
 * Terms, a privacy notice and a refund policy are on the critical path to
 * payments rather than beside it — Stripe asks for all three during Connect
 * onboarding, and a privacy notice is required outright for a site that stores
 * names, email addresses, uploaded photographs and uploaded video of people in
 * the UK and EU.
 *
 * The *documents* can be drafted from the code, and are: every claim the
 * privacy notice makes about what is collected, who processes it and how long
 * it is kept was read out of this repository rather than adapted from a
 * template. What cannot be drafted from the code is who is publishing them.
 * That is this file.
 *
 * -----------------------------------------------------------------------------
 * WHY THE GAPS ARE A DATA STRUCTURE AND NOT A `TODO`
 * -----------------------------------------------------------------------------
 * A `TODO` in a legal document is invisible to everyone who is not reading the
 * source, which is everyone the document is for. So every unknown is `null`
 * here, exactly once, and three things fall out of that automatically:
 *
 *   1. `<Fact>` renders a **visible** marker in place of the missing value, so
 *      the page cannot be read as finished.
 *   2. {@link legalGaps} lists what is outstanding, and the pages print that
 *      list at the top rather than making a reader discover it line by line.
 *   3. {@link legalIsComplete} is false, and each page sets
 *      `robots: { index: false }` on that basis — an unfinished legal page
 *      indexed by Google is worse than no page, because it is quotable.
 *
 * Filling these in is one edit to one object. Nothing else has to change, and
 * the `noindex` lifts on its own.
 *
 * -----------------------------------------------------------------------------
 * THIS IS A DRAFT AND IT SAYS SO ON EVERY PAGE
 * -----------------------------------------------------------------------------
 * A structurally complete, factually accurate draft is worth a great deal — it
 * is most of the work and it is the part that needs to know how the software
 * behaves. It is not legal advice and it has not been reviewed by anyone
 * qualified to give any. The banner on each page says that, and it is not
 * decoration: publishing these unreviewed is a decision for whoever owns the
 * company, not for whoever wrote the components.
 */

/** ISO date the drafts were last edited. Shown on each page. */
export const LEGAL_LAST_UPDATED = '2026-09-01';

export interface LegalFacts {
  /** Registered company name, e.g. "JavelinHub Ltd". Not the product name. */
  legalName: string | null;
  /** Companies House (or equivalent) registration number. */
  companyNumber: string | null;
  /** Registered address, one line per element. */
  registeredAddress: readonly string[] | null;
  /** Where a user sends a general enquiry or a notice under the terms. */
  contactEmail: string | null;
  /**
   * Where a data-protection request goes. May be the same address as
   * `contactEmail`; it is separate because it usually should not be, and
   * because a privacy notice has to name one specifically.
   */
  privacyEmail: string | null;
  /** e.g. "England and Wales". Decides the courts and the consumer regime. */
  governingLaw: string | null;
  /**
   * The supervisory authority a complaint can be made to — the ICO for a UK
   * controller. Required content for a UKGDPR/GDPR notice.
   */
  supervisoryAuthority: string | null;
  /**
   * Days a buyer has to request a refund on a delivered offer. A number, not a
   * sentence, because `/legal/refunds` renders it in three places and they must
   * not be able to disagree.
   *
   * NOTE what this interacts with: for digital content supplied immediately,
   * UK/EU consumer law lets a trader ask the buyer to waive the 14-day
   * cancellation right, and `fulfilment = 'instant'` is exactly that case. The
   * refund page says so; the number here is the *policy* on top of the statute.
   */
  refundWindowDays: number | null;
  /** Commission retained on a sale, as a percentage. Names the money split. */
  platformFeePercent: number | null;
}

/**
 * **EVERY VALUE HERE IS DELIBERATELY `null`.** Fill them in and the banners,
 * the inline markers and the `noindex` all clear themselves.
 *
 * Do not invent one to make a page look finished. A registered address that is
 * wrong is worse than one that is visibly missing, and a refund window nobody
 * agreed to is a promise the business has to keep.
 */
export const LEGAL: LegalFacts = {
  legalName: null,
  companyNumber: null,
  registeredAddress: null,
  contactEmail: null,
  privacyEmail: null,
  governingLaw: null,
  supervisoryAuthority: null,
  refundWindowDays: null,
  platformFeePercent: null,
};

/** Human labels, so the gap list reads as a to-do rather than as field names. */
const LABELS: Record<keyof LegalFacts, string> = {
  legalName: 'the registered company name',
  companyNumber: 'the company registration number',
  registeredAddress: 'the registered address',
  contactEmail: 'a contact email address',
  privacyEmail: 'a data-protection contact address',
  governingLaw: 'the governing law and jurisdiction',
  supervisoryAuthority: 'the supervisory authority for complaints',
  refundWindowDays: 'the refund window, in days',
  platformFeePercent: 'the commission percentage',
};

/** Which facts are still missing, as sentences. Empty means the drafts are fillable. */
export function legalGaps(): string[] {
  return (Object.keys(LABELS) as Array<keyof LegalFacts>)
    .filter((key) => {
      const value = LEGAL[key];
      return value === null || (Array.isArray(value) && value.length === 0);
    })
    .map((key) => LABELS[key]);
}

/**
 * True when every fact is supplied.
 *
 * It does NOT mean the documents have been reviewed by a lawyer, and nothing in
 * this file can know that. The drafting banner therefore does not key off this
 * — it is unconditional, and removing it is a deliberate edit somebody makes
 * once the review has actually happened.
 */
export function legalIsComplete(): boolean {
  return legalGaps().length === 0;
}
