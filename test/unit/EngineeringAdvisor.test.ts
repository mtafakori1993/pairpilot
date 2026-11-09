/**
 * EngineeringAdvisor tests (spec section 10).
 *
 * The advisor must recommend exactly one next step, must not recommend a file
 * that already exists, and must fall back to working local analysis when the AI
 * is unavailable. The "already exists" guard is the important one: recommending
 * work that is already done is the failure mode that erodes trust in the feature.
 */

import { describe, expect, it } from 'vitest';
import {
  EngineeringAdvisor,
  extractReferences,
} from '../../src/core/EngineeringAdvisor';

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function advisor(): EngineeringAdvisor {
  return new EngineeringAdvisor({ workspaceRoot: '/project', logger });
}

describe('extractReferences: JavaScript and TypeScript', () => {
  it('finds a default import', () => {
    const refs = extractReferences("import { UserService } from './user-service';");
    expect(refs.map((r) => r.specifier)).toContain('./user-service');
    expect(refs[0]!.relative).toBe(true);
  });

  it('finds a side-effect import', () => {
    expect(extractReferences("import './polyfills';").map((r) => r.specifier)).toContain(
      './polyfills'
    );
  });

  it('finds a require call', () => {
    expect(extractReferences("const x = require('./legacy');").map((r) => r.specifier)).toContain(
      './legacy'
    );
  });

  it('finds a re-export', () => {
    expect(extractReferences("export * from './barrel';").map((r) => r.specifier)).toContain(
      './barrel'
    );
  });

  it('marks a bare package specifier as non-relative', () => {
    const refs = extractReferences("import express from 'express';");
    expect(refs[0]!.relative).toBe(false);
    expect(refs[0]!.candidates).toEqual([]);
  });

  it('de-duplicates repeated imports', () => {
    const refs = extractReferences(
      ["import a from './x';", "import b from './x';"].join('\n')
    );
    expect(refs.filter((r) => r.specifier === './x')).toHaveLength(1);
  });

  it('generates extension candidates for a relative specifier', () => {
    const ref = extractReferences("import { A } from './user-service';")[0]!;
    expect(ref.candidates).toContain('./user-service.ts');
    expect(ref.candidates).toContain('./user-service.js');
    expect(ref.candidates).toContain('./user-service/index.ts');
  });

  it('keeps an explicit extension as the only candidate', () => {
    const ref = extractReferences("import { A } from './thing.vue';")[0]!;
    expect(ref.candidates).toEqual(['./thing.vue']);
  });
});

describe('extractReferences: other languages', () => {
  it('finds a Python relative import', () => {
    const refs = extractReferences('from .services import user');
    expect(refs.map((r) => r.specifier)).toContain('./services');
  });

  it('finds a Python parent-relative import', () => {
    const refs = extractReferences('from ..models import user');
    expect(refs.map((r) => r.specifier)).toContain('../models');
  });

  it('finds a Ruby require_relative', () => {
    expect(
      extractReferences("require_relative 'services/user_service'").map((r) => r.specifier)
    ).toContain('./services/user_service');
  });

  it('finds a PHP require', () => {
    expect(extractReferences("require_once 'src/Helper.php';").map((r) => r.specifier)).toContain(
      'src/Helper.php'
    );
  });

  it('maps a PHP use statement onto candidate file paths', () => {
    const refs = extractReferences('use App\\Services\\UserService;');
    const mapped = refs.find((r) => r.specifier === 'App\\Services\\UserService');
    expect(mapped).toBeDefined();
    expect(mapped!.candidates.some((c) => c.endsWith('UserService.php'))).toBe(true);
  });
});

describe('EngineeringAdvisor: local analysis', () => {
  it('recommends creating a missing relative import', () => {
    const result = advisor().analyseLocally({
      relativePath: 'src/user-controller.ts',
      code: "import { UserService } from './user-service';",
      dependencies: [],
      existingPaths: ['src/user-controller.ts'],
    });

    expect(result).not.toBeNull();
    expect(result!.title).toMatch(/user-service/);
    expect(result!.required).toBe(true);
    expect(result!.source).toBe('local');
  });

  it('does not recommend a file that already exists', () => {
    // The whole point: no advice to redo finished work.
    const result = advisor().analyseLocally({
      relativePath: 'src/user-controller.ts',
      code: "import { UserService } from './user-service';",
      dependencies: [],
      existingPaths: ['src/user-controller.ts', 'src/user-service.ts'],
    });
    expect(result).toBeNull();
  });

  it('ignores a bare package import, which is not a file to create', () => {
    const result = advisor().analyseLocally({
      relativePath: 'src/a.ts',
      code: "import express from 'express';",
      dependencies: ['express'],
      existingPaths: ['src/a.ts'],
    });
    expect(result).toBeNull();
  });

  it('resolves a relative import against the source file directory', () => {
    const result = advisor().analyseLocally({
      relativePath: 'src/controllers/user.ts',
      code: "import { Repo } from '../repositories/user-repo';",
      dependencies: [],
      existingPaths: ['src/controllers/user.ts'],
    });
    expect(result).not.toBeNull();
    expect(result!.files[0]).toBe('src/repositories/user-repo.ts');
  });

  it('prefers a sibling of the source file when several candidates exist', () => {
    const result = advisor().analyseLocally({
      relativePath: 'src/a.ts',
      code: "import { B } from './b';",
      dependencies: [],
      existingPaths: ['src/a.ts'],
    });
    expect(result!.files[0]).toBe('src/b.ts');
  });

  it('returns null when there is nothing missing', () => {
    const result = advisor().analyseLocally({
      relativePath: 'src/a.ts',
      code: 'export const a = 1;\n',
      dependencies: [],
      existingPaths: ['src/a.ts'],
    });
    expect(result).toBeNull();
  });

  it('suggests responsibilities naming the file', () => {
    const result = advisor().analyseLocally({
      relativePath: 'src/a.ts',
      code: "import { UserService } from './user-service';",
      dependencies: [],
      existingPaths: ['src/a.ts'],
    });
    expect(result!.responsibilities.length).toBeGreaterThan(0);
    expect(result!.reason).toMatch(/will not resolve/i);
  });
});

describe('EngineeringAdvisor: parsing AI advice', () => {
  const input = {
    relativePath: 'src/a.ts',
    code: 'export const a = 1;',
    dependencies: [],
    existingPaths: ['src/a.ts'],
  };

  it('parses a bare recommendation', () => {
    const reply = JSON.stringify({
      title: 'Create UserService',
      reason: 'The controller needs it.',
      responsibilities: ['Hold user logic'],
      files: ['src/user-service.ts'],
      required: true,
    });
    const result = advisor().parseAdvisorReply(reply, input);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Create UserService');
    expect(result!.source).toBe('ai');
    expect(result!.required).toBe(true);
  });

  it('parses a fenced recommendation', () => {
    const reply = '```json\n{"title":"T","reason":"R","required":false}\n```';
    expect(advisor().parseAdvisorReply(reply, input)!.title).toBe('T');
  });

  it('drops a recommendation for a file that already exists', () => {
    const reply = JSON.stringify({
      title: 'Create a.ts',
      reason: 'because',
      files: ['src/a.ts'],
      required: true,
    });
    const result = advisor().parseAdvisorReply(reply, input);
    expect(result!.files).toEqual([]);
  });

  it('returns null for prose rather than a half-parsed guess', () => {
    expect(advisor().parseAdvisorReply('You should probably add a service.', input)).toBeNull();
  });

  it('returns null when the required fields are missing', () => {
    expect(advisor().parseAdvisorReply('{"reason":"only a reason"}', input)).toBeNull();
    expect(advisor().parseAdvisorReply('{"title":"only a title"}', input)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(advisor().parseAdvisorReply('', input)).toBeNull();
    expect(advisor().parseAdvisorReply('   ', input)).toBeNull();
  });

  it('bounds field lengths from untrusted output', () => {
    const reply = JSON.stringify({
      title: 'x'.repeat(5000),
      reason: 'y'.repeat(50_000),
      responsibilities: Array.from({ length: 100 }, () => 'z'.repeat(2000)),
      files: [],
    });
    const result = advisor().parseAdvisorReply(reply, input)!;
    expect(result.title.length).toBeLessThanOrEqual(300);
    expect(result.reason.length).toBeLessThanOrEqual(2000);
    expect(result.responsibilities.length).toBeLessThanOrEqual(10);
  });

  it('ignores a non-array responsibilities field', () => {
    const reply = JSON.stringify({ title: 'T', reason: 'R', responsibilities: 'nope' });
    expect(advisor().parseAdvisorReply(reply, input)!.responsibilities).toEqual([]);
  });

  it('treats a non-true required field as optional', () => {
    const reply = JSON.stringify({ title: 'T', reason: 'R', required: 'yes' });
    expect(advisor().parseAdvisorReply(reply, input)!.required).toBe(false);
  });
});
