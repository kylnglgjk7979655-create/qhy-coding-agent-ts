// 槽位名是仓库 Secret 的名称，不包含凭据。每个槽位独立刷新和回存。
function authSlots(value = process.env.CODEX_AUTH_SLOTS || '') {
  const slots = value.trim() ? JSON.parse(value) : ['CODEX_AUTH_JSON'];
  if (!Array.isArray(slots) || !slots.length || slots.length > 16
    || slots.some((slot) => typeof slot !== 'string' || (!/^CODEX_AUTH_JSON(?:_[A-Z0-9]+)*$/.test(slot) || slotLabel(slot).length > 50))
    || new Set(slots).size !== slots.length) throw new Error('CODEX_AUTH_SLOTS 必须是 1–16 个不重复的 CODEX_AUTH_JSON 系列 Secret 名称。');
  return slots;
}
function selectAuthSlot(number, requested, value) {
  const slots = authSlots(value);
  if (!Number.isSafeInteger(Number(number)) || Number(number) < 0) throw new Error('任务编号必须是非负安全整数。');
  if (requested && !slots.includes(requested)) throw new Error('请求的认证槽位未配置。');
  return requested || slots[Number(number) % slots.length];
}
function slotLabel(slot) { return `agent:auth-${slot.toLowerCase().replaceAll('_', '-')}`; }
module.exports = { authSlots, selectAuthSlot, slotLabel };
