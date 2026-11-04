# TypeScript 演示仓库

业务规则：订单金额达到 100 时享九折。`src/checkout.ts` 有一个已知边界 bug：金额恰好为 100 时没有折扣。

使用 pnpm 9.12.3；`.npmrc` 会自动下载并选择 Node.js 24.22.2：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:bug
```

`pnpm test` 的 3 个基础测试通过；`pnpm test:bug` 是已知 bug 的回归测试，起始时应失败（100 !== 90），修复后应通过。

父工程中运行 `pnpm demo:init`，会从本模板复制出独立的 `.demo-workspace/` Git 仓库，创建干净起始提交并标记 `demo-start`。该副本与父工程 Git 历史独立。

随后在父工程运行 `pnpm dev --workspace ./.demo-workspace`，启动后输入需求，Agent 即可通过 `read_file`、`write_file` 读取或修改副本内的文件。例如要求它读取 `src/checkout.ts` 和 `regression/discount.test.ts`，修复金额恰好为 100 时未打折的问题。输入 `/exit` 退出；Agent 当前没有命令执行工具，测试仍需由用户在副本目录运行。
