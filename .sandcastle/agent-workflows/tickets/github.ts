import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { z } from 'zod';

const issueSchema = z.object({
  id: z.number().int(), number: z.number().int().positive(), title: z.string(),
  body: z.string().nullable().transform((body) => body ?? ''),
  state: z.enum(['open', 'closed']), state_reason: z.string().nullable().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  user: z.object({ login: z.string() }),
  pull_request: z.unknown().optional(),
});
export type Issue = z.infer<typeof issueSchema>;
export interface Comment {
  id: number; body: string; created_at: string; updated_at: string;
  user: { login: string; type: string };
}
const require = createRequire(import.meta.url);
const { assertSafeInputs, decodeRequest, renderRequest } = require('../../../.github/scripts/task-queue.cjs') as {
  assertSafeInputs: (inputs: unknown) => void;
  decodeRequest: (body: string) => { id: string } | undefined;
  renderRequest: (request: Record<string, unknown>) => string;
};
export const hasLabel = (issue: Issue, label: string): boolean =>
  issue.labels.some((entry) => (typeof entry === 'string' ? entry : entry.name) === label);

export class GitHub {
  constructor(readonly repo: string, private readonly token = process.env.GH_TOKEN) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new Error('GH_REPO 必须为 owner/repo。');
  }

  api<T>(method: string, resource: string, body?: unknown): T {
    const args = ['api', '-H', 'X-GitHub-Api-Version: 2026-03-10', '--method', method, `repos/${this.repo}/${resource}`];
    if (body !== undefined) args.push('--input', '-');
    const result = execFileSync('gh', args, {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
      env: { ...process.env, ...(this.token ? { GH_TOKEN: this.token } : {}) },
    });
    return (result.trim() ? JSON.parse(result) : null) as T;
  }

  list<T>(resource: string): T[] {
    const separator = resource.includes('?') ? '&' : '?';
    return (JSON.parse(execFileSync('gh', [
      'api', '-H', 'X-GitHub-Api-Version: 2026-03-10', '--paginate', '--slurp', `repos/${this.repo}/${resource}${separator}per_page=100`,
    ], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.token ? { GH_TOKEN: this.token } : {}) },
    })) as T[][]).flat();
  }

  issue(number: number): Issue { return issueSchema.parse(this.api('GET', `issues/${number}`)); }
  issues(query: string): Issue[] {
    return this.list<unknown>(`issues?${query}`).map((value) => issueSchema.parse(value)).filter((issue) => !issue.pull_request);
  }
  children(number: number): Issue[] {
    return this.list<unknown>(`issues/${number}/sub_issues`).map((value) => issueSchema.parse(value));
  }
  blockers(number: number): Issue[] {
    return this.list<unknown>(`issues/${number}/dependencies/blocked_by`).map((value) => issueSchema.parse(value));
  }
  dependents(number: number): Issue[] {
    return this.list<unknown>(`issues/${number}/dependencies/blocking`).map((value) => issueSchema.parse(value));
  }
  comments(number: number): Comment[] { return this.list<Comment>(`issues/${number}/comments`); }
  comment(number: number, body: string): void { this.api('POST', `issues/${number}/comments`, { body }); }
  queueTask(request: { id: string; kind: string; number: number; workflow: string; inputs: Record<string, string> }): void {
    assertSafeInputs(request.inputs);
    if (!this.comments(request.number).some((comment) => comment.user.login === 'github-actions[bot]' && decodeRequest(comment.body)?.id === request.id)) {
      this.comment(request.number, renderRequest({ version: 1, ...request, queuedAt: new Date().toISOString(), status: 'waiting' }));
    }
    this.api('POST', 'actions/workflows/agent-queue.yml/dispatches', { ref: 'main', inputs: {} });
  }
  addLabels(number: number, labels: string[]): void { this.api('POST', `issues/${number}/labels`, { labels }); }
  removeLabel(issue: Issue, label: string): void {
    if (hasLabel(issue, label)) this.api('DELETE', `issues/${issue.number}/labels/${encodeURIComponent(label)}`);
  }

  parent(number: number): number | null {
    const [owner, name] = this.repo.split('/');
    const response = JSON.parse(execFileSync('gh', [
      'api', 'graphql', '-f', 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{number}}}}',
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`,
    ], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.token ? { GH_TOKEN: this.token } : {}) },
    })) as { data?: { repository: { issue: { parent: { number: number } | null } } }; errors?: unknown[] };
    if (response.errors || !response.data?.repository.issue) throw new Error('无法读取父 Issue，停止执行。');
    return response.data.repository.issue.parent?.number ?? null;
  }
}
