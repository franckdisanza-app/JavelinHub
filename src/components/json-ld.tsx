import { headers } from 'next/headers';

/**
 * =============================================================================
 * A JSON-LD block, escaped and nonce'd.
 * =============================================================================
 *
 * Next's own JSON-LD guide recommends a native `<script type="application/ld+json">`
 * rendered from the page — not `next/script`, which is for executable code —
 * and this is that, with the two things a hand-written version keeps getting
 * wrong done in one place instead of at every call site.
 *
 * -----------------------------------------------------------------------------
 * 1. `<` IS ESCAPED, AND THAT IS NOT DECORATION
 * -----------------------------------------------------------------------------
 * The payload here is user-authored: an offer's title and description, a
 * coach's name and headline. An HTML parser reading a `<script>` element stops
 * at the first `</script` it sees regardless of JSON quoting, so a coach whose
 * offer description contains that string would close the block early and have
 * everything after it parsed as markup. `JSON.stringify` does not protect
 * against this — Next's guide says so in as many words — and replacing every
 * `<` with its unicode escape does, while leaving the JSON semantically
 * identical.
 *
 * -----------------------------------------------------------------------------
 * 2. IT CARRIES THE CSP NONCE
 * -----------------------------------------------------------------------------
 * `src/proxy.ts` enforces `script-src 'self' 'nonce-…' 'strict-dynamic'`. A
 * data block is not executed and the spec does not require it to be nonce'd,
 * but browsers have not been consistent about that, and the failure mode is a
 * console violation and no structured data at all — silent, because nothing on
 * the page looks different. The nonce costs one header read and removes the
 * question.
 *
 * `x-nonce` is set by the proxy on every path its matcher covers. `null` is
 * possible in principle (a path it does not cover), and the attribute is then
 * simply omitted rather than rendered as the string "null".
 *
 * -----------------------------------------------------------------------------
 * WHAT DOES NOT BELONG IN HERE
 * -----------------------------------------------------------------------------
 * Anything a signed-in viewer can see and a stranger cannot. Structured data is
 * addressed to crawlers, so a block built from a viewer-scoped read would
 * publish one person's view of a page to everybody. Every caller passes facts
 * that are already on the public surface of the same page.
 */
export async function JsonLd({ data }: { data: Record<string, unknown> }) {
  const nonce = (await headers()).get('x-nonce');

  return (
    <script
      type="application/ld+json"
      nonce={nonce ?? undefined}
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
