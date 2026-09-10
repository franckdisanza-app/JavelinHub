import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DELIVERY_MAX_BYTES,
  DELIVERY_MIME_TYPES,
  checkDeliveryFile,
  checkDeliveryFileContent,
  safeFileName,
} from '@/lib/storage/deliverables';

/**
 * =============================================================================
 * What may be uploaded, and what its name may be.
 * =============================================================================
 *
 * Two boundaries, both reached by strangers exchanging files with each other:
 *
 *   * `safeFileName` decides the object key and the `download` attribute the
 *     other party clicks;
 *   * `checkDeliveryFile` / `checkDeliveryFileContent` decide whether the bytes
 *     are allowed in at all.
 *
 * Neither is reachable from the other suites — an upload needs storage, which
 * the mock backend does not have, so `verify:authz` and `verify:pages` cannot
 * exercise either one. These are pure functions over a `File`, which node has.
 */

/** A `File` whose head is `bytes` and whose declared type is `type`. */
function fileOf(bytes: number[], type: string, name = 'file'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const ASCII = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const PDF = ASCII('%PDF-1.7');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [...ASCII('RIFF'), 0, 0, 0, 0, ...ASCII('WEBP')];
const MP4 = [0, 0, 0, 0x20, ...ASCII('ftypisom')];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** `MZ` — the DOS header every Windows executable starts with. */
const EXE = [0x4d, 0x5a, 0x90, 0x00];

describe('checkDeliveryFile — size and declared type', () => {
  it('accepts a file inside both bounds', () => {
    assert.equal(checkDeliveryFile(fileOf(PDF, 'application/pdf')).ok, true);
  });

  it('refuses an empty file', () => {
    assert.equal(checkDeliveryFile(fileOf([], 'application/pdf')).ok, false);
  });

  it('refuses a type that is not on the list', () => {
    assert.equal(checkDeliveryFile(fileOf(EXE, 'application/x-msdownload')).ok, false);
    assert.equal(checkDeliveryFile(fileOf(PDF, '')).ok, false);
  });

  it('states a size ceiling that matches the buckets', () => {
    assert.equal(DELIVERY_MAX_BYTES, 50 * 1024 * 1024);
  });
});

describe('checkDeliveryFileContent — the bytes, not the claim', () => {
  it('accepts every type on the list when the bytes agree', async () => {
    const cases: Array<[string, number[]]> = [
      ['application/pdf', PDF],
      ['image/png', PNG],
      ['image/jpeg', JPEG],
      ['image/webp', WEBP],
      ['video/mp4', MP4],
      ['video/quicktime', MP4],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
      ['text/plain', ASCII('hello')],
      ['text/csv', ASCII('a,b,c')],
    ];

    for (const [type, bytes] of cases) {
      const result = await checkDeliveryFileContent(fileOf(bytes, type));
      assert.equal(result.ok, true, `${type} was refused: ${result.message}`);
    }
  });

  /**
   * THE CASE THIS EXISTS FOR. `file.type` comes from the browser's guess at the
   * extension, so renaming `payload.exe` to `plan.pdf` produced a file that
   * satisfied both the app's list and the bucket's `allowed_mime_types` —
   * neither of which had looked at a single byte.
   */
  it('refuses an executable wearing a document extension', async () => {
    const result = await checkDeliveryFileContent(fileOf(EXE, 'application/pdf', 'plan.pdf'));
    assert.equal(result.ok, false);
    assert.match(result.message ?? '', /does not look like/i);
  });

  it('refuses every mismatched pairing of two things it does know', async () => {
    const mismatches: Array<[string, number[]]> = [
      ['image/png', JPEG],
      ['image/jpeg', PNG],
      ['application/pdf', ZIP],
      ['video/mp4', PDF],
      ['image/webp', ASCII('RIFFxxxxAVI ')],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', PDF],
    ];

    for (const [type, bytes] of mismatches) {
      const result = await checkDeliveryFileContent(fileOf(bytes, type));
      assert.equal(result.ok, false, `${type} accepted the wrong bytes`);
    }
  });

  /**
   * Text has no signature, so the only available check is for a byte no text
   * file contains. Named as the heuristic it is, and asserted so that it at
   * least catches the obvious case.
   */
  it('refuses binary content declared as text', async () => {
    const withNul = [...ASCII('hello'), 0, ...ASCII('world')];
    assert.equal((await checkDeliveryFileContent(fileOf(withNul, 'text/plain'))).ok, false);
    assert.equal((await checkDeliveryFileContent(fileOf(EXE, 'text/csv'))).ok, false);
  });

  /**
   * FAILS CLOSED. Reaching this with an unknown type means the signature table
   * and `DELIVERY_MIME_TYPES` have drifted, and the safe reading of "we do not
   * know how to check this" is no.
   */
  it('refuses a type it has no signature for', async () => {
    assert.equal((await checkDeliveryFileContent(fileOf(EXE, 'application/x-msdownload'))).ok, false);
    assert.equal((await checkDeliveryFileContent(fileOf(PDF, ''))).ok, false);
  });

  /**
   * The drift check itself, as an assertion rather than as a comment: every
   * accepted type must have a signature, or a file of that type would be
   * refused by a check nobody meant to apply to it.
   */
  it('has a signature for every type the size check accepts', async () => {
    for (const type of DELIVERY_MIME_TYPES) {
      const result = await checkDeliveryFileContent(fileOf(ASCII('nonsense bytes'), type));
      // Either it matched (text does) or it failed on the SIGNATURE rather than
      // on the type being unknown. The distinction is the message.
      assert.equal(
        /cannot be checked/i.test(result.message ?? ''),
        false,
        `${type} is accepted by checkDeliveryFile but has no signature`,
      );
    }
  });
});

describe('safeFileName', () => {
  it('keeps an ordinary name', () => {
    assert.equal(safeFileName('training-plan.pdf'), 'training-plan.pdf');
    assert.equal(safeFileName('Week 1 plan.pdf'), 'Week 1 plan.pdf');
  });

  it('strips directories, in both separators', () => {
    assert.equal(safeFileName('/etc/passwd'), 'passwd');
    assert.equal(safeFileName('C:\\Users\\me\\plan.pdf'), 'plan.pdf');
    assert.equal(safeFileName('../../../etc/passwd'), 'passwd');
  });

  it('never returns a name that begins with a dot', () => {
    assert.equal(safeFileName('.htaccess'), 'htaccess');
    assert.equal(safeFileName('...hidden'), 'hidden');
  });

  it('replaces anything outside the safe set', () => {
    assert.equal(safeFileName('plan;rm -rf.pdf'), 'plan_rm -rf.pdf');
    assert.equal(safeFileName('quote".pdf'), 'quote_.pdf');
  });

  it('never returns an empty name', () => {
    assert.equal(safeFileName(''), 'file');
    assert.equal(safeFileName('///'), 'file');
    assert.equal(safeFileName('...'), 'file');
  });

  it('caps the length', () => {
    assert.equal(safeFileName(`${'a'.repeat(500)}.pdf`).length, 120);
  });

  it('removes control characters rather than encoding them', () => {
    const name = `plan${String.fromCharCode(10)}.pdf`;
    const cleaned = safeFileName(name);
    assert.equal(cleaned, 'plan.pdf');
  });
});
