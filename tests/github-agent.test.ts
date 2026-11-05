import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createIssuePrompt } from '../.sandcastle/issue-context.js';

const require = createRequire(import.meta.url);
const { issueNumber, relatedPr, prepare } = require('../.github/scripts/agent.cjs') as {
  issueNumber: (value: unknown) => number;
  relatedPr: (pr: { head: { ref: string }; body?: string | null }, number: number) => boolean;
  prepare: (args: { github: unknown; context: unknown; core: unknown }) => Promise<void>;
};

describe('GitHub Issue 自动实现的输入边界', () => {
  it.each(['0', '-1', '1; echo secret', '1\n2', '9007199254740992', undefined])('拒绝非法编号 %s', (value) => {
    expect(() => issueNumber(value)).toThrow();
  });

  it('接受正整数编号', () => {
    expect(issueNumber('42')).toBe(42);
  });

  it.each(['Fixes #42', 'closes #42\n', 'Resolved #42'])('识别关联 PR：%s', (body) => {
    expect(relatedPr({ head: { ref: 'fix/custom' }, body }, 42)).toBe(true);
  });

  it('区分相邻编号和普通提及，同时识别先前创建的 Codex 分支', () => {
    expect(relatedPr({ head: { ref: 'fix/custom' }, body: 'Fixes #420' }, 42)).toBe(false);
    expect(relatedPr({ head: { ref: 'fix/custom' }, body: 'See #42' }, 42)).toBe(false);
    expect(relatedPr({ head: { ref: 'codex/issue-42-123-1' }, body: null }, 42)).toBe(true);
    expect(relatedPr({ head: { ref: 'codex/issue-420-123-1' } }, 42)).toBe(false);
  });

  it('保留特殊字符和评论内容，作为 JSON 需求数据传入提示词', () => {
    const issue = { number: 42, title: '修复 `code` 和 $(command)', body: '正文\n第二行', url: 'https://github.com/example/repo/issues/42', comments: [{ author: 'qhy', body: '{{MODEL}}' }] };
    const prompt = createIssuePrompt(issue, '实现需求');
    expect(prompt.startsWith('实现需求')).toBe(true);
    expect(prompt.endsWith(JSON.stringify(issue, null, 2))).toBe(true);
  });

  it('在启动模型前拒绝缺少需求内容的上下文', () => {
    expect(() => createIssuePrompt({ number: 42 }, '实现需求')).toThrow();
  });

  it('仓库转为公开后拒绝订阅任务，且不访问任何凭据', async () => {
    await expect(prepare({
      github: {}, context: { payload: { repository: { private: false } } }, core: { setOutput: vi.fn() },
    })).rejects.toThrow('只允许在私有仓库');
  });

  it('拒绝无写权限的触发者，在读取需求或修改标签前停止', async () => {
    const getIssue = vi.fn();
    const github = { rest: {
      repos: { getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({ data: { permission: 'read' } }) },
      issues: { get: getIssue },
    } };
    const context = { repo: { owner: 'owner', repo: 'repo' }, actor: 'visitor', payload: { repository: { private: true }, issue: { number: 42 } } };
    await expect(prepare({ github, context, core: { setOutput: vi.fn() } })).rejects.toThrow('写权限');
    expect(getIssue).not.toHaveBeenCalled();
  });

  it('发现已有 PR 时移除两个触发标签，不再次启动 Agent', async () => {
    const removeLabel = vi.fn().mockResolvedValue({});
    const createComment = vi.fn().mockResolvedValue({});
    const setOutput = vi.fn();
    const github = {
      rest: {
        repos: { getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({ data: { permission: 'write' } }) },
        issues: { get: vi.fn().mockResolvedValue({ data: { state: 'open' } }), removeLabel, createComment },
        pulls: { list: vi.fn() },
      },
      paginate: vi.fn().mockResolvedValue([{ head: { ref: 'codex/issue-42-123-1' }, html_url: 'https://github.com/owner/repo/pull/43' }]),
    };
    const context = { repo: { owner: 'owner', repo: 'repo' }, actor: 'maintainer', payload: { repository: { private: true }, issue: { number: 42 } } };
    await prepare({ github, context, core: { setOutput, notice: vi.fn() } });
    expect(removeLabel.mock.calls.map(([args]) => args.name)).toEqual(['ready-for-agent', 'agent:implement']);
    expect(createComment.mock.calls[0]?.[0].body).toContain('/pull/43');
    expect(setOutput).not.toHaveBeenCalledWith('proceed', 'true');
  });
});
