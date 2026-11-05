export type ReviewAxis = 'Standards' | 'Spec';
export type ReviewReports = Record<ReviewAxis, string>;

// 两个视角各自使用新会话，串行运行以复用一份订阅认证。
export async function runReviewPhases<T>(options: {
  review: (axis: ReviewAxis) => Promise<string>;
  assertReadOnly: () => Promise<void>;
  repair: (reports: ReviewReports) => Promise<T>;
}): Promise<T> {
  const Standards = await options.review('Standards');
  await options.assertReadOnly();
  const Spec = await options.review('Spec');
  await options.assertReadOnly();
  return options.repair({ Standards, Spec });
}
