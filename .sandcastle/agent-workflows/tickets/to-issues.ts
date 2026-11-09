import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Output, run } from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { codexAgent, fail, required, standardSchema, writeJson } from '../shared/common.js';
import { planFromDraft } from './plan.js';

try {
  const source = JSON.parse(readFileSync(required('SOURCE_FILE'), 'utf8')) as {
    issue: { number: number; title: string }; source_hash: string;
  };
  const result = await run({
    name: `to-issues-#${source.issue.number}`,
    agent: codexAgent(), sandbox: noSandbox(), logging: { type: 'stdout' },
    promptFile: path.join(import.meta.dirname, 'prompt.md'),
    promptArgs: { PRD_NUMBER: String(source.issue.number), PRD_TITLE: source.issue.title },
    completionSignal: '</output>',
    output: Output.object({ tag: 'output', maxRetries: 2, schema: standardSchema((value) => {
      const plan = planFromDraft(value, source.issue.number, source.source_hash);
      return plan;
    }) }),
  });
  writeJson('plan.json', result.output);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
