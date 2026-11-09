import { describe, expect, it } from 'vitest';
import { assertAcyclic } from '../.sandcastle/agent-workflows/implement-spec/dependencies.js';

describe('spec 子任务依赖', () => {
  it('接受并行分支及其汇合依赖', () => {
    expect(() => assertAcyclic(new Map([[1, []], [2, []], [3, [1, 2]]]))).not.toThrow();
  });

  it('拒绝循环及不存在的前置任务', () => {
    expect(() => assertAcyclic(new Map([[1, [2]], [2, [1]]]))).toThrow('无法执行');
    expect(() => assertAcyclic(new Map([[1, [2]]]))).toThrow('无法执行');
  });
});
