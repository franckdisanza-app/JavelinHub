/**
 * Node module-resolution hook so plain `node` can import the project's
 * TypeScript sources directly — no bundler, no build step, no extra dependency.
 *
 * Node 22.18+/24 strips TypeScript types natively, but its ESM resolver knows
 * nothing about two things this project uses: the `@/*` path alias from
 * tsconfig.json, and extensionless relative imports. This hook supplies both.
 *
 * Used only by `npm run verify:authz`. Not part of the application build.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(PROJECT_ROOT, 'src');

function firstExistingFile(base) {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // Unreadable path: fall through to the next candidate.
    }
  }
  return null;
}

function hit(file) {
  return { url: pathToFileURL(file).href, shortCircuit: true, format: 'module-typescript' };
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const file = firstExistingFile(path.join(SRC, specifier.slice(2)));
    if (file) return hit(file);
  }

  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const file = firstExistingFile(path.resolve(parentDir, specifier));
    if (file) return hit(file);
  }

  return nextResolve(specifier, context);
}
