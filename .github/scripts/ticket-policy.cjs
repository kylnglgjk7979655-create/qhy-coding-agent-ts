function labelNames(issue) {
  return (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name);
}
function isHumanTask(issue) {
  return issue.execution === 'human-qa' || labelNames(issue).includes('ready-for-human')
    || /^QA\s*:/i.test(issue.title ?? '')
    || /^\s*\*{0,2}Execution\*{0,2}\s*:\*{0,2}\s*Human\s+QA\b/im.test(issue.body ?? '')
    || /^\s*\*{0,2}Status\*{0,2}\s*:\*{0,2}\s*ready-for-human\b/im.test(issue.body ?? '');
}
function isCompleted(issue) {
  return String(issue.state).toLowerCase() === 'closed'
    && String(issue.stateReason ?? issue.state_reason).toLowerCase() !== 'not_planned';
}
function isAgentOpen(issue) { return issue.state === 'open' && !isHumanTask(issue); }
function selectReadyChild(children, dependencies) {
  return children.find((child) => isAgentOpen(child)
    && (dependencies.get(child.number) ?? []).every(isCompleted));
}
function parentReference(number, children) {
  // 包含人工验收的父规格由人确认关闭，PR 合并只关联、不自动关闭。
  return `${children.some(isHumanTask) ? 'Refs' : 'Closes'} #${number}`;
}
module.exports = { labelNames, isHumanTask, isCompleted, isAgentOpen, selectReadyChild, parentReference };
