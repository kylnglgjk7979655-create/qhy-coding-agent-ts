import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as sandcastle from "@ai-hero/sandcastle";

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

export const DEFAULT_AGENT_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://qianfan.baidubce.com/anthropic/tokenplan/personal";

// 唯一的模型适配：沿用官方任务编排，通过 Anthropic 兼容端点调用 Claude Code。
export const claudeAgent = () => {
  const model = process.env.AGENT_MODEL?.trim() || DEFAULT_AGENT_MODEL;
  console.log(`Agent 模型：${model}`);
  return sandcastle.claudeCode(model, {
    env: {
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: required("ANTHROPIC_AUTH_TOKEN"),
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });
};

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
