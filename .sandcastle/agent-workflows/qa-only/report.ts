import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { asArray, asRecord, asString, standardSchema } from '../shared/common.js';

const statuses = ['pass', 'fail', 'blocked', 'not-run'] as const;
type CheckStatus = typeof statuses[number];

export interface QaCheck {
  readonly id: string;
  readonly specReference: string;
  readonly steps: string;
  readonly expected: string;
  readonly actual: string;
  readonly status: CheckStatus;
  readonly evidence: string[];
}

export interface QaOutput {
  readonly spec: string;
  readonly summary: string;
  readonly checks: QaCheck[];
  readonly findings: string[];
  readonly humanQa: string[];
}

const strings = (value: unknown, label: string) =>
  asArray(value, label).map((item) => asString(item, label));

export const qaOutputSchema = standardSchema<QaOutput>((value) => {
  const record = asRecord(value, 'QA output');
  const ids = new Set<string>();
  const checks = asArray(record.checks, 'checks').map((value): QaCheck => {
    const check = asRecord(value, 'check');
    const id = asString(check.id, 'check id');
    if (ids.has(id)) throw new Error(`重复的 QA ID：${id}`);
    ids.add(id);
    const status = asString(check.status, `${id} status`);
    if (!statuses.some((entry) => entry === status)) throw new Error(`无效的 QA 状态：${status}`);
    const evidence = strings(check.evidence, `${id} evidence`);
    if ((status === 'pass' || status === 'fail') && evidence.length === 0) {
      throw new Error(`${id} 缺少实际运行证据。`);
    }
    return {
      id, status: status as CheckStatus, evidence,
      specReference: asString(check.specReference, `${id} specReference`),
      steps: asString(check.steps, `${id} steps`),
      expected: asString(check.expected, `${id} expected`),
      actual: asString(check.actual, `${id} actual`),
    };
  });
  return {
    spec: asString(record.spec, 'spec'),
    summary: asString(record.summary, 'summary'),
    checks,
    findings: strings(record.findings ?? [], 'findings'),
    humanQa: strings(record.humanQa ?? [], 'humanQa'),
  };
});

/** 总结果由所有必验项计算，空计划或未完成检查不能成为 pass。 */
export function qaVerdict(output: QaOutput): 'pass' | 'fail' | 'blocked' {
  if (output.checks.some((check) => check.status === 'fail')) return 'fail';
  return output.checks.length > 0 && output.checks.every((check) => check.status === 'pass')
    ? 'pass' : 'blocked';
}

/** 发布的每个证据引用都必须对应本次 artifact 内的非空普通文件。 */
export function verifyEvidence(output: QaOutput, directory: string): void {
  const root = realpathSync(directory);
  for (const check of output.checks) {
    for (const file of check.evidence) {
      if (path.isAbsolute(file)) throw new Error(`证据路径必须相对 artifact 目录：${file}`);
      const full = realpathSync(path.resolve(root, file));
      const relative = path.relative(root, full);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`证据路径超出本次 artifact：${file}`);
      }
      const stat = statSync(full);
      if (!stat.isFile() || stat.size === 0) {
        throw new Error(`证据必须是非空文件：${file}`);
      }
    }
  }
}

/** 两种 QA 入口共享验收项与证据表，修复及发布信息由各自 workflow 补充。 */
export function renderQaChecks(output: QaOutput): string {
  const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
  return [
    '## QA plan 与结果', '',
    '| ID | Spec 引用 | 初态与操作 | 预期 | 实际 | 状态 | 证据 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...output.checks.map((check) => `| ${[
      check.id, check.specReference, check.steps, check.expected, check.actual,
      check.status, check.evidence.join(', '),
    ].map(cell).join(' | ')} |`), '',
    '## 其他 findings', '', ...output.findings.map((finding) => `- ${finding}`),
    ...(output.findings.length ? [] : ['无。']), '',
    '## 人工 QA', '', ...output.humanQa.map((item) => `- ${item}`),
    ...(output.humanQa.length ? [] : ['本次没有新增人工执行记录。']), '',
  ].join('\n');
}

export function renderQaReport(output: QaOutput, snapshot: { head: string; workingTree: string }, fixedPoint: string): string {
  return [
    '# QA Only', '',
    `- Result: **${qaVerdict(output)}**`,
    `- Tested HEAD: \`${snapshot.head}\``,
    `- Fixed point: \`${fixedPoint}\``,
    `- Working tree: ${snapshot.workingTree ? '运行前已有未提交改动，结论包含该工作树。' : 'clean'}`,
    `- Spec: ${output.spec}`, '', output.summary, '',
    renderQaChecks(output),
    '本次仅验收和报告；未执行修复、提交或 PR Ready 转换。', '',
  ].join('\n');
}
