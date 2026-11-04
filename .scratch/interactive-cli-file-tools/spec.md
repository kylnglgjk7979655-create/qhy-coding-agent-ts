Status: ready-for-agent

## Problem Statement

The CLI currently accepts one prompt as a command-line argument and returns one model response. A user cannot stay in the terminal for a continuous conversation, and the Agent cannot inspect or edit project files. This makes it difficult to use the CLI for iterative coding work even though the project already has API key configuration, a single Agent, conversation IDs, and a tool loop.

## Solution

Start the CLI directly in an interactive conversation loop. Accept one message at a time, show the model's response, complete the turn, and then wait for the next message. Add `read_file` and `write_file` tools so the Agent can read workspace content, make requested edits, receive tool results, and continue answering. Preserve conversation ID continuation, the existing `runtimeInfo` tool, model/API key configuration, and the configured tool-step limit.

## User Stories

1. As a CLI user, I want the program to enter a conversation as soon as it starts, so that I do not need to pass my first message as a command-line argument.
2. As a CLI user, I want to type a message into the terminal and see the model's reply, so that I can interact with the Agent naturally.
3. As a CLI user, I want the reply to finish before the CLI asks for my next message, so that each turn is easy to follow.
4. As a CLI user, I want to send multiple messages in one process, so that the Agent can use the earlier conversation as context.
5. As a CLI user, I want to enter `/exit` to close the conversation, so that I can leave the interactive session explicitly.
6. As a CLI user, I want a new conversation ID created when I start without one, so that I can continue this conversation in a later process.
7. As a CLI user, I want to provide an existing conversation ID at startup, so that the Agent can load and continue its saved message history.
8. As a CLI user, I want each completed turn to be saved with its user message, Agent response, and tool exchanges, so that a later process can continue with the full context.
9. As a CLI user, I want an incomplete or failed turn not to be saved, so that persisted history represents completed turns only.
10. As a CLI user, I want a failed turn to report its error and return to the input loop, so that a single failure does not close my conversation.
11. As a CLI user, I want the new conversation ID included in the existing run logs, so that I can copy it when I want to resume the conversation.
12. As a CLI user, I want to ask the Agent to inspect a workspace file, so that its response can be based on the actual project content.
13. As a CLI user, I want to ask the Agent to modify a workspace file based on its contents, so that it can make a useful project change in one conversation.
14. As a CLI user, I want the Agent to receive the result of each file-tool call, so that it can continue its reasoning and provide a final response after using a tool.
15. As a CLI user, I want file-tool errors returned to the Agent, so that it can explain the problem or try an appropriate next step.
16. As a CLI user, I want the terminal to show the name of each invoked tool without printing its arguments or full result, so that I can see tool activity without flooding the conversation output.
17. As a CLI user, I want relative file paths resolved from the configured workspace, so that file requests have a predictable project root.
18. As a CLI user, I want absolute file paths accepted only when their resolved targets remain inside the workspace, so that I can use known paths without extending the Agent's access beyond the project.
19. As a CLI user, I want symlinks that resolve outside the workspace to be rejected, so that a path inside the workspace cannot bypass the file-access boundary.
20. As a CLI user, I want the Agent to create or replace a file directly without a per-operation confirmation, so that requested edits can proceed without interrupting the conversation.
21. As a CLI user, I want `write_file` to replace the complete file contents, so that the Agent can write a coherent updated file.
22. As a CLI user, I want `write_file` to return an error when the parent directory does not exist, so that it does not create unexpected directory structures.
23. As a CLI user, I want the Agent to keep using the configured `maxSteps` limit, so that tool activity remains bounded per turn.
24. As a CLI user, I want the existing model and API key configuration to continue working, so that the interactive CLI uses the provider setup already available in the project.
25. As a CLI user, I want the existing `runtimeInfo` capability to remain available, so that existing Agent behavior and diagnostics continue to work.
26. As a CLI user, I want the real-tool smoke command to exercise `read_file` and verify that its result informs the final model response, so that the smoke check covers the new file-tool round trip.

## Implementation Decisions

- The command-line entry point starts an interactive input loop without requiring a positional prompt. The existing conversation ID option remains available for resuming a conversation.
- `/exit` ends the loop. Between turns, the CLI waits for the next user message only after the current Agent run has completed.
- The Agent processes one user message as one conversation turn. The existing tool loop and configured `maxSteps` limit apply to each turn.
- Each successful turn appends the user message, Agent response, and tool exchanges to the conversation history and saves that history. Failed or incomplete turns are not persisted. A turn failure is reported and the input loop remains active.
- The new conversation ID is surfaced through the existing JSON run logs. Conversation history remains available through the existing conversation ID mechanism.
- The Agent retains `runtimeInfo` and adds `read_file` and `write_file`.
- `read_file` accepts a path and returns file contents. `write_file` accepts a path and complete new contents, creates or replaces the target file, and does not create missing parent directories.
- Relative file paths resolve from the configured workspace. Absolute paths are accepted only when their canonical resolved target remains inside the workspace. Symlinks that resolve outside the workspace are rejected. This follows the accepted workspace-scoped file-access ADR.
- File reads and writes inside the workspace execute without an approval prompt. The terminal displays tool names only; tool arguments and results are returned to the Agent rather than printed as tool output.
- Tool errors are returned as tool results to the Agent, allowing the Agent to continue the tool loop and answer the user.
- Keep current model, API key, timeout, logging, and cancellation configuration behavior unless the interactive loop requires adapting how a run is scoped to one turn.
- Update the real-tool smoke behavior to use a generated probe file and `read_file`, then verify that the final model response uses the returned probe. Keep `runtimeInfo` available to normal Agent runs.

## Testing Decisions

- Prefer behavior tests at the compiled CLI boundary. A good test launches the CLI as a child process, supplies terminal input, observes terminal output and exit behavior, and checks persisted conversation state through the public conversation ID mechanism. It should assert externally visible behavior rather than internal helper calls.
- Use the existing local OpenAI-compatible HTTP fixture and a temporary workspace as the primary seam. The fixture can return model text, request file-tool calls, inspect tool results in the next provider request, and exercise provider failures without a live API key.
- Cover startup directly into input mode, multiple ordered turns, `/exit`, new and resumed conversation IDs, persistence after successful turns, omission of failed turns, and continued input after a failed turn.
- Cover `read_file` content delivery, complete-file replacement by `write_file`, missing-parent errors, relative and in-workspace absolute path handling, path traversal rejection, symlink escape rejection, tool-name-only terminal output, and tool-error return to the Agent.
- Cover the configured step limit per turn and ensure the CLI remains available for another message after a turn failure.
- Adapt existing smoke coverage to force a `read_file` call, verify the tool result is present in the next model request, and verify the final answer uses the probe. Keep a regression assertion that `runtimeInfo` remains available.
- Prior art is the current compiled CLI integration suite, which runs the built CLI against a local HTTP provider fixture and checks stdout, stderr events, tool round trips, configuration failures, cancellation, and step-limit behavior.

## Out of Scope

- Multiple Agents, subagents, and Agent delegation.
- Shell or command execution tools.
- File access outside the configured workspace.
- Per-tool-call approval prompts for paths inside the workspace.
- Automatic creation of missing parent directories for file writes.
- A new model provider, credential format, or API key management flow.
- Changes to the conversation ID persistence format or cross-process continuation model.

## Further Notes

- Use the project's glossary terms for conversation, conversation turn, workspace, and Agent.
- The spec is published with the `ready-for-agent` triage status.
- This draft uses the agreed test seam: the compiled CLI, local provider fixture, and temporary workspace.
