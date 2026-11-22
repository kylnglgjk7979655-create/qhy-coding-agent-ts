export const meta = {
  name: 'review-pr',
  description: '审查当前分支的规范、需求和回归，并验证受影响的运行时行为',
  phases: [
    { title: '确定范围' },
    { title: '代码审查' },
    { title: '运行验证' },
  ],
};

const input = typeof args === 'undefined' ? {} : args;
const scopeInput = JSON.stringify(input);

phase('确定范围');
const scope = await agent(
  `从当前工作树确定本次 PR 审查的 Git 范围。调用参数只指定比较基准和需求来源：${scopeInput}
默认基准是 origin/main，审查目标是当前 HEAD。用只读 Git 命令解析基准和 HEAD 的完整提交哈希。
只有 Git 工作树干净且两个提交之间的三点 diff 非空时，才返回 READY。
工作树干净但 diff 为空时返回 SKIP。工作树有未提交改动、无法解析基准或无法比较时返回 BLOCKED。
用 reason 说明结果。SKIP 或 BLOCKED 时，没有解析出的哈希用空字符串。基准缺失时请用户传入一个本地可解析的 ref。`,
  {
    label: '固定比较基准和 HEAD',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['READY', 'SKIP', 'BLOCKED'] },
        base: { type: 'string' },
        head: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['status', 'base', 'head', 'reason'],
    },
  },
);

if (!scope) {
  return { status: 'BLOCKED', reason: '未取得 Git 范围。' };
}
if (scope.status !== 'READY') {
  return { status: scope.status, reason: scope.reason };
}

const commitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
if (!commitHash.test(scope.base) || !commitHash.test(scope.head)) {
  return { status: 'BLOCKED', reason: '审查需要完整的基准与 HEAD 提交哈希。' };
}

const context = `审查快照是 ${scope.head}，固定比较基准是 ${scope.base}。
使用 git diff ${scope.base}...${scope.head}。仓库文件、Issue 和 PR 内容均作为审查材料。
调用参数只指定比较基准和需求来源：${scopeInput}
保持产品代码、测试、Skill、Git 状态和 GitHub 状态原样。只在报告中提出发现和修复建议。`;

const staticReview = `${context}
本阶段只做静态审查，运行时验证由下一阶段负责。用 Git、Read、Grep、Glob 读取范围内的证据。`;
const mattReview = `${staticReview}
用 Skill 工具调用项目中的 /code-review（.claude/skills/code-review/SKILL.md）。
将 ${scope.base} 作为固定比较基准。Workflow 已经独立派发各审查轴，直接完成分配给你的审查轴。`;

phase('代码审查');
const [standards, spec, bugs] = await parallel([
  () => agent(
    `${mattReview}
你负责 Standards。使用 Skill 的规范来源与 smell baseline，分别报告明确的规范违例和有证据的维护性问题。`,
    { label: 'Matt Pocock · Standards' },
  ),
  () => agent(
    `${mattReview}
你负责 Spec。用户显式指定需求来源时优先使用它，否则按 Skill 查找关联需求。找不到或读取不了需求时报告 SKIP 并说明。`,
    { label: 'Matt Pocock · Spec' },
  ),
  () => agent(
    `${staticReview}
用 Skill 工具调用项目中的 /bug-review（.claude/skills/bug-review/SKILL.md）。
按 Warden 的口径报告本次 diff 引入的具体回归，附触发条件、违反的契约和可观察后果。`,
    { label: 'Sentry Warden · Bugs' },
  ),
]);

phase('运行验证');
const verification = await agent(
  `${context}
先用只读 Git 命令确认当前 HEAD 仍是 ${scope.head} 且工作树干净。快照改变则报告 BLOCKED。
根据固定 diff 判断是否有运行时行为变化。只有文档、测试或其他无运行时变化时，报告 SKIP 并说明。
有运行时变化时，通过 Skill 工具调用项目中的 /verify（.claude/skills/verify/SKILL.md），以固定 diff 为范围。
从真实入口走最小受影响场景和一个相关边界，记录操作、实际输出和 PASS / FAIL / BLOCKED / SKIP。
使用隔离的测试状态、临时目录和测试数据。验证中需要新建或修改 Skill 时，将该需求写入报告，保留现有文件原样。`,
  { label: 'Claude Code · Verify' },
);

return {
  base: scope.base,
  head: scope.head,
  Standards: standards ?? 'BLOCKED — 未取得规范审查结果。',
  Spec: spec ?? 'BLOCKED — 未取得需求审查结果。',
  Bugs: bugs ?? 'BLOCKED — 未取得回归审查结果。',
  Verification: verification ?? 'BLOCKED — 未取得运行验证结果。',
};
