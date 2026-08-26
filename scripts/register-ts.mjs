/**
 * Registers ./ts-loader.mjs. Used as `node --import ./scripts/register-ts.mjs`.
 */
import { register } from 'node:module';

const [major, minor] = process.versions.node.split('.').map(Number);
const stripsTypes = major > 22 || (major === 22 && minor >= 18);

if (!stripsTypes) {
  console.error(
    `This script imports the project's .ts sources directly, which needs Node 22.18+ ` +
      `(native type stripping). You are on ${process.versions.node}.`,
  );
  process.exit(1);
}

register('./ts-loader.mjs', import.meta.url);
