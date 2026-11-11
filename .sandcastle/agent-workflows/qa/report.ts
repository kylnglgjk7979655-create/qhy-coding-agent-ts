import { asArray, asRecord, asString, standardSchema, validate } from '../shared/common.js';
import { qaOutputSchema, qaVerdict as checkVerdict, renderQaChecks } from '../qa-only/report.js';
import type { QaOutput } from '../qa-only/report.js';

interface Repair {
  readonly issue: string;
  readonly attempts: number;
  readonly resolved: boolean;
  readonly commits: string[];
}

export interface QaWorkflowOutput extends QaOutput {
  readonly testedHead: string | null;
  readonly reviewedHead: string | null;
  readonly reviewSummary: string;
  readonly repairs: Repair[];
  readonly unresolvedFindings: string[];
}

const commit = (value: unknown): string => {
  const sha = asString(value, 'commit');
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('commit 必须是完整 SHA。');
  return sha;
};

export const qaWorkflowOutputSchema = standardSchema<QaWorkflowOutput>((value) => {
  const record = asRecord(value, 'QA workflow output');
  return {
    ...validate(qaOutputSchema, value),
    testedHead: record.testedHead === null ? null : commit(record.testedHead),
    reviewedHead: record.reviewedHead === null ? null : commit(record.reviewedHead),
    reviewSummary: asString(record.reviewSummary, 'reviewSummary'),
    unresolvedFindings: asArray(record.unresolvedFindings, 'unresolvedFindings').map((item) => asString(item, 'finding')),
    repairs: asArray(record.repairs, 'repairs').map((value): Repair => {
      const repair = asRecord(value, 'repair');
      if (typeof repair.attempts !== 'number' || !Number.isInteger(repair.attempts)
        || repair.attempts < 1 || repair.attempts > 3 || typeof repair.resolved !== 'boolean') {
        throw new Error('每个问题必须保留 1–3 次修复尝试及解决状态。');
      }
      return {
        issue: asString(repair.issue, 'repair issue'), attempts: repair.attempts, resolved: repair.resolved,
        commits: asArray(repair.commits, 'repair commits').map(commit),
      };
    }),
  };
});

export function qaVerdict(output: QaWorkflowOutput): 'pass' | 'fail' | 'blocked' {
  if (output.repairs.some((repair) => !repair.resolved)) return 'fail';
  const verdict = checkVerdict(output);
  // 文本未完成项可能只是阻塞说明；由逐项执行结果区分 fail 与 blocked。
  if (verdict !== 'pass') return verdict;
  return output.unresolvedFindings.length ? 'fail' : 'pass';
}

/** 通过结论必须对应最终提交；修复还须经过独立 CR。 */
export function verifyFinalHead(output: QaWorkflowOutput, initialHead: string, finalHead: string): void {
  if (qaVerdict(output) !== 'pass') return;
  if (output.testedHead !== finalHead) throw new Error('通过结论未验收最终 HEAD。');
  if ((initialHead !== finalHead || output.repairs.length > 0) && output.reviewedHead !== finalHead) {
    throw new Error('修复后的最终 HEAD 缺少通过的 CR。');
  }
}

export function renderQaReport(output: QaWorkflowOutput, initialHead: string, finalHead: string): string {
  return [
    '# QA', '',
    `- Result: **${qaVerdict(output)}**`,
    `- Tested HEAD: \`${output.testedHead ?? '未执行'}\``,
    '- Fixed point: `main`',
    `- Spec: ${output.spec}`, '', output.summary, '',
    renderQaChecks(output),
    '## 修复与 CR', '',
    `- Initial HEAD: \`${initialHead}\``,
    `- Final HEAD: \`${finalHead}\``,
    `- Reviewed HEAD: \`${output.reviewedHead ?? '无新增修复或 CR 未通过'}\``,
    output.reviewSummary, '',
    ...output.repairs.map((repair) => `- ${repair.issue}：尝试 ${repair.attempts}/3 次，${repair.resolved ? '已解决' : '未解决'}${!repair.resolved && repair.attempts === 3 ? '；达到最大修复次数，验收未通过' : ''}。提交：${repair.commits.join(', ') || '无'}`),
    '', '## 未完成项', '',
    ...(output.unresolvedFindings.length ? output.unresolvedFindings.map((finding) => `- ${finding}`) : ['无未解决的范围内 findings；受阻或未执行的验收项见上表。']), '',
  ].join('\n');
}
