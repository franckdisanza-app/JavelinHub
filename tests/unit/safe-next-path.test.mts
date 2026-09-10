import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { safeNextPath } from '@/lib/auth/paths';

/**
 * =============================================================================
 * `?next=` — the open-redirect boundary.
 * =============================================================================
 *
 * This is the function that decides where a login form is allowed to send
 * somebody after they authenticate, and it is reached from three places, all of
 * them holding attacker-supplied input: the login page's query string, the auth
 * callback's, and the signup action's form data.
 *
 * ITS OWN COMMENT RECORDS A BUG THAT SHIPPED — `"/<tab>/evil.example"` passed a
 * denylist of `//` and `/\`, because browsers strip the tab and resolve what is
 * left as a protocol-relative URL. Nothing executable was asserting any of it:
 * `verify:authz` never renders, `verify:pages` reads served HTML, and neither
 * can reach a pure function. These are the cases from that comment, plus the
 * ones around them.
 *
 * THE CONTROL CHARACTERS ARE BUILT WITH `String.fromCharCode`, not written as
 * escapes. A test about characters that get silently rewritten is a bad place
 * for a literal that can itself be silently rewritten — by an editor, a
 * copy-paste, or a tool touching this file. A code point cannot be mistyped
 * invisibly.
 */

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);

/** True when `value` carries a byte no `Location` header may contain. */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

describe('safeNextPath', () => {
  it('keeps an ordinary same-site path', () => {
    assert.equal(safeNextPath('/offers'), '/offers');
    assert.equal(safeNextPath('/coach/offers'), '/coach/offers');
  });

  it('keeps the query and the fragment, which is the whole promise', () => {
    assert.equal(safeNextPath('/offers?q=javelin#reviews'), '/offers?q=javelin#reviews');
  });

  it('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      assert.equal(safeNextPath(value), null, `accepted ${JSON.stringify(value)}`);
    }
  });

  it('refuses a value that does not start with a slash', () => {
    assert.equal(safeNextPath('offers'), null);
    assert.equal(safeNextPath(''), null);
    assert.equal(safeNextPath('   '), null);
  });

  it('refuses an absolute URL, whatever its scheme', () => {
    for (const value of [
      'https://evil.example/',
      'http://evil.example/offers',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'HTTPS://evil.example',
    ]) {
      assert.equal(safeNextPath(value), null, `accepted ${value}`);
    }
  });

  it('refuses a protocol-relative URL', () => {
    assert.equal(safeNextPath('//evil.example'), null);
    assert.equal(safeNextPath('//evil.example/offers'), null);
  });

  it('refuses the backslash spellings a browser normalises to a host', () => {
    assert.equal(safeNextPath('/\\evil.example'), null);
    assert.equal(safeNextPath('\\\\evil.example'), null);
  });

  /**
   * The regression, and the exact input the function's own comment names.
   *
   * `/<tab>/evil.example` starts with exactly one slash and contains no
   * backslash, so the old denylist passed it — and the URL parser then STRIPS
   * the tab, leaving `//evil.example`, which resolves off-site. Browsers strip
   * exactly three characters this way: tab, carriage return and line feed.
   */
  it('refuses the three characters a URL parser strips', () => {
    assert.equal(safeNextPath(`/${TAB}/evil.example`), null);
    assert.equal(safeNextPath(`/${LF}/evil.example`), null);
    assert.equal(safeNextPath(`/${CR}/evil.example`), null);
  });

  /**
   * Every OTHER control character is percent-encoded rather than stripped, so
   * it stays same-origin and is returned rather than refused.
   *
   * This is the distinction that makes parsing right and a denylist wrong — and
   * "returned" still has to mean "harmless": the result is a path on our own
   * site, and the raw byte is gone. Both halves are asserted, here and in the
   * sweep below.
   */
  it('percent-encodes what it does not strip, rather than refusing it', () => {
    assert.equal(safeNextPath(`/${NUL}/evil.example`), '/%00/evil.example');
    assert.equal(safeNextPath('/ /evil.example'), '/%20/evil.example');
  });

  /**
   * The second half of the original bug: a newline reaching Node's header
   * writer threw `ERR_INVALID_CHAR ["Location"]`, turning one crafted link into
   * an unauthenticated 500. Whatever comes back is put in a `Location` header,
   * so nothing it returns may carry a raw control character.
   */
  it('never returns a value carrying a raw control character', () => {
    const crafted = [
      `/offers${LF}`,
      `/offers${CR}${LF}Location: https://evil.example`,
      `/off${TAB}ers`,
      `/${NUL}/evil.example`,
      `/${BELL}bell`,
      `/offers?q=${NUL}`,
      `/offers#${CR}`,
    ];

    for (const value of crafted) {
      const result = safeNextPath(value);
      if (result === null) continue;
      assert.ok(
        !hasControlCharacter(result),
        `returned a raw control character for ${JSON.stringify(value)}: ${JSON.stringify(result)}`,
      );
    }
  });

  it('refuses a path longer than the ceiling', () => {
    assert.equal(safeNextPath(`/${'a'.repeat(2048)}`), null);
    assert.notEqual(safeNextPath(`/${'a'.repeat(100)}`), null);
  });

  /**
   * `..` is not a security boundary here — every result is same-origin by
   * construction — but it must resolve rather than escape, and the parser is
   * what guarantees that. Asserted because "it resolves" is easy to assume.
   */
  it('normalises traversal rather than letting it escape', () => {
    assert.equal(safeNextPath('/offers/../../../etc/passwd'), '/etc/passwd');
  });
});
