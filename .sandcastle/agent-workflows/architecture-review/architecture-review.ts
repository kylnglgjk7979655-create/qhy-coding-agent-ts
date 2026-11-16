import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Output } from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { z } from 'zod';
import { claudeAgent, fail, writeJson } from '../shared/common.js';
import { runWithExtraction } from '../shared/run-with-extraction.js';

const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('proposed'), title: z.string().trim().min(1).max(256), body: z.string().trim().min(1), oneLineSummary: z.string().trim().min(1), candidatesConsidered: z.array(z.string().trim().min(1)).min(1) }),
  z.object({ status: z.literal('skipped'), reason: z.string().trim().min(1) }),
]);

try {
  const result = await runWithExtraction({
    name: 'architecture-review', agent: claudeAgent(), sandbox: noSandbox(), logging: { type: 'stdout' },
    promptFile: path.join(import.meta.dirname, 'prompt.md'),
    output: Output.object({ tag: 'output', schema: resultSchema }),
    extractionPrompt: readFileSync(path.join(import.meta.dirname, 'extraction.md'), 'utf8'),
  });
  writeJson('architecture-review.json', result.output);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
