#!/usr/bin/env node
/**
 * Check that translated READMEs stay in sync with README.md.
 *
 * Sync is defined structurally, not textually: a translation must have exactly
 * the same set of headings and fenced code blocks in the same order. That is
 * enough to catch the common failure (a section added or removed in English and
 * forgotten in the translations) without forcing a brittle line-by-line diff.
 *
 * Exit codes: 0 in sync, 1 out of sync, 2 configuration error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const SOURCE = join(root, 'README.md');

/** Translations, with the marker that identifies a sync point. */
const TRANSLATIONS = [
  { file: 'README.zh-CN.md', label: '简体中文' },
  { file: 'README.ja.md', label: '日本語' },
];

/** Lines that legitimately differ between locales. */
const IGNORED_PREFIXES = ['[', '![', '<!--'];

function stripIgnorable(lines) {
  return lines.filter((line) => {
    const trimmed = line.trim();
    return !IGNORED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  });
}

/**
 * Reduce a document to its structural signature: every heading level and every
 * opening code fence, in order.
 *
 * Heading TEXT is deliberately excluded. A translation is supposed to differ
 * there, so including it would report every translated heading as a mismatch.
 * What must match is position, nesting level and code-block language, which is
 * enough to catch a section added, removed, reordered or wrongly nested in one
 * language only.
 */
function signature(source) {
  const out = [];
  let inFence = false;

  for (const line of stripIgnorable(source.split('\n'))) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      // Only record the opening fence; the language tag is part of the sample
      // and must match so code samples cannot drift apart.
      if (!inFence) out.push(`fence:${trimmed.slice(3).trim() || '(none)'}`);
      inFence = !inFence;
      continue;
    }

    if (inFence) continue;

    const heading = /^(#{1,6})\s+\S/.exec(trimmed);
    if (heading) out.push(`h${heading[1].length}`);
  }

  return out;
}

function compare(sourceSig, targetSig) {
  const problems = [];

  const max = Math.max(sourceSig.length, targetSig.length);
  for (let i = 0; i < max; i++) {
    const source = sourceSig[i];
    const target = targetSig[i];
    if (source === undefined) {
      problems.push(`extra structure at position ${i + 1}: ${target}`);
      continue;
    }
    if (target === undefined) {
      problems.push(`missing structure at position ${i + 1}: expected ${source}`);
      continue;
    }
    if (source !== target) {
      problems.push(
        `position ${i + 1}: expected ${source}, got ${target}`,
      );
    }
  }

  return problems;
}

/**
 * Catch mojibake before it ships. A U+FFFD in a translation means a character was
 * lost somewhere in the pipeline, and it renders as a visible black diamond.
 */
function findEncodingDamage(source, file) {
  const problems = [];
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    if (line.includes('\uFFFD')) {
      problems.push(`line ${index + 1}: contains a replacement character (mojibake)`);
    }
    // A lone lone surrogate renders as nothing at all and breaks JSON tooling.
    for (const char of line) {
      const code = char.codePointAt(0);
      if (code >= 0xd800 && code <= 0xdfff) {
        problems.push(`line ${index + 1}: contains an unpaired surrogate`);
        break;
      }
    }
  });

  return problems.map((problem) => `[${file}] ${problem}`);
}

function main() {
  if (!existsSync(SOURCE)) {
    process.stderr.write('README.md not found\n');
    return 2;
  }

  const sourceSig = signature(readFileSync(SOURCE, 'utf8'));
  let outOfSync = 0;

  for (const translation of TRANSLATIONS) {
    const path = join(root, translation.file);

    if (!existsSync(path)) {
      process.stdout.write(`SKIP  ${translation.file} (not present yet)\n`);
      continue;
    }

    const targetSource = readFileSync(path, 'utf8');
    const encodingProblems = findEncodingDamage(targetSource, translation.file);
    const targetSig = signature(targetSource);
    const problems = [...compare(sourceSig, targetSig), ...encodingProblems];

    if (problems.length === 0) {
      process.stdout.write(
        `OK    ${translation.file}  ${targetSig.length} structural elements match\n`,
      );
    } else {
      outOfSync += 1;
      process.stdout.write(`STALE ${translation.file}\n`);
      for (const problem of problems.slice(0, 20)) {
        process.stdout.write(`        ${problem}\n`);
      }
      if (problems.length > 20) {
        process.stdout.write(`        ... and ${problems.length - 20} more\n`);
      }
    }
  }

  if (outOfSync > 0) {
    process.stdout.write(
      `\n${outOfSync} translation(s) out of sync with README.md.\n` +
        'Translations must cover the same headings and code blocks, in the same order.\n',
    );
    return 1;
  }

  process.stdout.write('\nAll translations in sync.\n');
  return 0;
}

process.exitCode = main();