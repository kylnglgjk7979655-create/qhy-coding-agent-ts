# Issue tracker: Local Markdown

## GitHub Actions 入口

通过 GitHub Actions 启动的 Codex 任务，以对应 GitHub Issue、PR 和评论为需求来源，由阶段脚本通过 `gh` 读取。上传的 spec 应放在父 Issue 正文，补充要求写在评论；拆票 prompt 使用 `gh issue view <编号> --comments` 直接获取，不要求仓库中存在本地 spec。`.scratch/` 只提供补充背景，本文件其余约定适用于本地 Markdown 需求。

云端拆票计划先保存为父 Issue 的机器人评论，添加 `agent:publish-tickets` 表示人工批准。发布脚本创建真正的 GitHub 子 Issue，通过原生 blocked-by 关系记录依赖，给子票添加 `ready-for-agent`；随后给父 Issue 添加 `agent:implement` 启动。完整流程与重试方式见 [GitHub Actions 与 Codex](./github-actions.md)。

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
