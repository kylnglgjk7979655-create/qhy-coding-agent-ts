export function assertAcyclic(dependencies: ReadonlyMap<number, readonly number[]>): void {
  const finished = new Set<number>();
  while (finished.size < dependencies.size) {
    const ready = [...dependencies].filter(([id, blockers]) => !finished.has(id) && blockers.every((blocker) => finished.has(blocker)));
    if (!ready.length) throw new Error('子任务依赖存在循环或引用了未知任务，无法执行。');
    for (const [id] of ready) finished.add(id);
  }
}
