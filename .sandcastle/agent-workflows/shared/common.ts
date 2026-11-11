import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as sandcastle from "@ai-hero/sandcastle";
import { codexAuthEnvironment, resolveCodexModel } from "../../codex-auth.js";

export const outputDir = (): string => process.env.OUTPUT_DIR ?? process.env.RUNNER_TEMP ?? "/tmp";

export const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
};

export const fail = (message: string): never => {
  console.error(`\nFAILED: ${message}`);
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), "failure_reason.txt"), message);
  process.exit(1);
};

export const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const safeSh = (cmd: string): string => {
  try {
    return sh(cmd);
  } catch {
    return "";
  }
};

export const gh = (args: string[]): string =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

export const writeJson = (filename: string, value: unknown): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(
    path.join(outputDir(), filename),
    JSON.stringify(value, null, 2),
  );
};

export const writeText = (filename: string, value: string): void => {
  fs.mkdirSync(outputDir(), { recursive: true });
  fs.writeFileSync(path.join(outputDir(), filename), value);
};

// 唯一的模型适配：沿用官方任务编排，使用现有 Codex 订阅及其会话目录。
export const codexAgent = () => {
  const command = (args: string[], env: NodeJS.ProcessEnv) => {
    const result = spawnSync("codex", args, { env, encoding: "utf8", timeout: 15_000 });
    if (result.error || result.status !== 0) throw new Error("Codex 配置检查失败。");
    return result.stdout + (args[0] === "login" ? result.stderr : "");
  };
  const env = codexAuthEnvironment(process.env, (childEnv) => command(["login", "status"], childEnv));
  const model = resolveCodexModel({ ...process.env, ...env }, (childEnv) => command(["debug", "models"], childEnv));
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  console.log(`Codex 模型：${model}`);
  const provider = sandcastle.codex(model, {
    effort: "high", env: { ...env, CODEX_HOME: codexHome }, captureSessions: true,
    sessionStorage: { hostSessionsDir: path.join(codexHome, "sessions") },
  });
  const parseStreamLine = provider.parseStreamLine.bind(provider);
  return {
    ...provider,
    parseStreamLine(line: string) {
      const events = parseStreamLine(line);
      const contextWindow = parseCodexContextWindowEvent(line);
      return contextWindow === undefined
        ? events
        : [...events, { type: "context_window" as const, contextWindow }];
    },
  };
};

function parseCodexContextWindowEvent(line: string): sandcastle.ContextWindow | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event) || event.type !== "event_msg" || !isRecord(event.payload)
      || event.payload.type !== "token_count" || !isRecord(event.payload.info)
      || !isRecord(event.payload.info.last_token_usage)) return undefined;

    const tokens = event.payload.info.last_token_usage.input_tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return undefined;
    const limit = event.payload.info.model_context_window;
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? { tokens, limit }
      : { tokens };
  } catch {
    return undefined;
  }
}

export const standardSchema = <T>(
  validate: (value: unknown) => T,
): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "sandcastle-agent-workflows",
    validate: (value: unknown) => {
      try {
        return { value: validate(value) };
      } catch (error) {
        return {
          issues: [
            {
              message:
                error instanceof Error ? error.message : "Validation failed",
            },
          ],
        };
      }
    },
  },
});

/** A plain JSON object (not null, not an array). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

export const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

export const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** A JSON text field: the string itself, or `fallback` for anything else. */
export const textOr = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

export const asArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
};

/** Run a schema built by `standardSchema` synchronously, throwing on failure. */
export const validate = <T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): T => {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new TypeError("Schema validation must be synchronous");
  }
  if (result.issues) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.value;
};
