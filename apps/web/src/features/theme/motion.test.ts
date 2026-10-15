import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../index.css'),
  'utf8',
);

const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
const reduced = start === -1 ? '' : css.slice(start);

describe('reduced motion', () => {
  it('shortens animations and transitions for people who ask for less movement', () => {
    expect(start).toBeGreaterThan(-1);
    expect(reduced).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(reduced).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(reduced).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it('keeps the spinner and the indeterminate bar moving, because they show that work is going on', () => {
    expect(reduced).toMatch(/\.animate-spin\s*\{[^}]*animation-duration:\s*1\.5s/);
    expect(reduced).toMatch(/\[role='progressbar'\] \*\s*\{[^}]*animation-duration:\s*1\.4s/);
  });
});
