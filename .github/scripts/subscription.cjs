const fs = require('node:fs/promises');
const path = require('node:path');

const SECRET_NAME = 'CODEX_AUTH_JSON';

function validateAuth(text) {
  let auth;
  try { auth = JSON.parse(text); } catch { throw new Error('Codex 登录文件不是有效 JSON。'); }
  if (Buffer.byteLength(text) > 48 * 1024 || auth?.auth_mode !== 'chatgpt'
    || typeof auth.tokens?.access_token !== 'string' || !auth.tokens.access_token
    || typeof auth.tokens?.refresh_token !== 'string' || !auth.tokens.refresh_token) {
    throw new Error('需要包含 access_token 和 refresh_token 的 ChatGPT 登录文件。请重新执行 codex login。');
  }
  return text;
}

function assertFreshSnapshot(updatedAt, createdAt) {
  const updated = Date.parse(updatedAt);
  const created = Date.parse(createdAt);
  if (!Number.isFinite(updated) || !Number.isFinite(created) || updated > created) {
    throw new Error('本次运行排队后订阅凭据已更新。请在上一轮结束后重新触发，避免恢复旧登录态。');
  }
}

async function publicKey({ github, context }) {
  if (process.env.AUTH_STORE_CONFIGURED !== 'true' || process.env.AUTH_JSON_CONFIGURED !== 'true') {
    throw new Error('请先配置 CODEX_AUTH_JSON 和 CODEX_AUTH_STORE_PAT 两个仓库 Secret。');
  }
  const { data: metadata } = await github.rest.actions.getRepoSecret({ ...context.repo, secret_name: SECRET_NAME });
  assertFreshSnapshot(metadata.updated_at, process.env.RUN_CREATED_AT);
  const { data: key } = await github.rest.actions.getRepoPublicKey(context.repo);
  const dir = path.join(process.env.RUNNER_TEMP, 'codex-public-key');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'key.json'), JSON.stringify({
    key: key.key, key_id: key.key_id, expected_updated_at: metadata.updated_at,
  }));
}

async function restore(mask = () => {}) {
  if (!process.env.CODEX_HOME) throw new Error('缺少 CODEX_HOME。');
  const auth = validateAuth(process.env.CODEX_AUTH_JSON || '');
  for (const value of Object.values(JSON.parse(auth).tokens)) {
    if (typeof value === 'string' && value) mask(value);
  }
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(process.env.CODEX_HOME, 'auth.json'), auth, { mode: 0o600 });
  await fs.writeFile(path.join(process.env.CODEX_HOME, 'config.toml'),
    'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n', { mode: 0o600 });
}

async function sealAuth(auth, key) {
  validateAuth(auth);
  const sodium = require('libsodium-wrappers');
  await sodium.ready;
  const publicKey = sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL);
  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) throw new Error('GitHub 加密公钥长度不正确。');
  return {
    key_id: key.key_id,
    expected_updated_at: key.expected_updated_at,
    encrypted_value: sodium.to_base64(sodium.crypto_box_seal(auth, publicKey), sodium.base64_variants.ORIGINAL),
  };
}

async function seal() {
  if (!process.env.CODEX_HOME) throw new Error('缺少 CODEX_HOME。');
  const auth = await fs.readFile(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8');
  const key = JSON.parse(await fs.readFile(path.join(process.env.RUNNER_TEMP, 'codex-public-key/key.json'), 'utf8'));
  const encrypted = await sealAuth(auth, key);
  const dir = path.join(process.env.RUNNER_TEMP, 'codex-auth-update');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'encrypted.json'), JSON.stringify(encrypted));
}

async function persist({ github, context }) {
  const file = path.join(process.env.RUNNER_TEMP, 'codex-auth-update/encrypted.json');
  const payload = JSON.parse(await fs.readFile(file, 'utf8'));
  if (typeof payload.encrypted_value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.encrypted_value)
    || payload.encrypted_value.length < 64 || payload.encrypted_value.length > 70_000
    || typeof payload.key_id !== 'string' || !/^[\w-]+$/.test(payload.key_id)
    || typeof payload.expected_updated_at !== 'string') {
    throw new Error('加密认证包格式错误，停止写回。');
  }
  const { data: current } = await github.rest.actions.getRepoSecret({ ...context.repo, secret_name: SECRET_NAME });
  if (current.updated_at !== payload.expected_updated_at) {
    throw new Error('运行期间凭据被其他操作更新，停止覆盖；请重新触发工作流。');
  }
  await github.rest.actions.createOrUpdateRepoSecret({
    ...context.repo, secret_name: SECRET_NAME,
    key_id: payload.key_id, encrypted_value: payload.encrypted_value,
  });
}

module.exports = { validateAuth, assertFreshSnapshot, publicKey, restore, sealAuth, seal, persist };

if (require.main === module) {
  const command = process.argv[2];
  const run = command === 'restore' ? restore : command === 'seal' ? seal : undefined;
  if (!run) throw new Error('只支持 restore 或 seal。');
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : '订阅认证操作失败。');
    process.exitCode = 1;
  });
}
