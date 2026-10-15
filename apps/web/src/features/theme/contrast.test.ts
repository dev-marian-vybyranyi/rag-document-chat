import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../index.css'),
  'utf8',
);

type Grey = { lightness: number; alpha: number };

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start, css.indexOf('}', start));
}

function token(selector: string, name: string): Grey {
  const match = new RegExp(`${name}: oklch\\(([\\d.]+) 0 0(?: / ([\\d.]+)%)?\\)`).exec(
    block(selector),
  );
  if (!match) throw new Error(`${name} is not a plain grey in ${selector}`);
  return { lightness: Number(match[1]), alpha: match[2] ? Number(match[2]) / 100 : 1 };
}

const luminance = (lightness: number) => lightness ** 3;

function over(top: Grey, bottom: Grey): number {
  const blended =
    top.alpha * luminance(top.lightness) + (1 - top.alpha) * luminance(bottom.lightness);
  return blended;
}

function contrast(top: Grey, bottom: Grey): number {
  const a = over(top, bottom);
  const b = luminance(bottom.lightness);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const AT_LEAST = 3;

describe.each([
  [':root', 'light'],
  ['.dark', 'dark'],
])('%s (%s theme)', (selector) => {
  const background = token(selector, '--background');
  const card = token(selector, '--card');
  const muted = token(selector, '--muted');

  it.each([
    ['page', background],
    ['card', card],
    ['muted area', muted],
  ])('shows the focus ring clearly against the %s', (_name, surface) => {
    expect(contrast(token(selector, '--ring'), surface)).toBeGreaterThanOrEqual(AT_LEAST);
  });

  it.each([
    ['page', background],
    ['card', card],
  ])('shows the edge of a text field clearly against the %s', (_name, surface) => {
    expect(contrast(token(selector, '--input'), surface)).toBeGreaterThanOrEqual(AT_LEAST);
  });
});

const TEXT_AT_LEAST = 4.5;

describe.each([
  [':root', 'light'],
  ['.dark', 'dark'],
])('%s (%s theme) secondary text', (selector) => {
  it.each(['--background', '--card', '--popover', '--muted'])('is readable on %s', (surface) => {
    expect(
      contrast(token(selector, '--muted-foreground'), token(selector, surface)),
    ).toBeGreaterThanOrEqual(TEXT_AT_LEAST);
  });
});
