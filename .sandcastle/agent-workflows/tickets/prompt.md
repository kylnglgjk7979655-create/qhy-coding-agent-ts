# TASK

You are breaking a PRD into a flat list of native GitHub sub-issues. You do
**not** create the issues yourself. You emit a structured plan for human
approval; after approval, the wrapping script creates and attaches the
sub-issues and their blocking dependencies deterministically.

- **PRD:** #{{PRD_NUMBER}} — {{PRD_TITLE}}

# CONTEXT

1. Fetch the PRD from GitHub:

   ```
   gh issue view {{PRD_NUMBER}} --comments
   ```

   The GitHub issue body and comments are the specification. Do not require
   a local spec file. If the PRD is ambiguous, make the most reasonable
   interpretation and proceed; do not stop to ask.

2. Read `GLOSSARY.md` and skim `docs/adr/` for any decisions that bear on
   the area the PRD touches. Sub-issue titles and bodies must use the
   project's vocabulary.

3. Explore the codebase to ground the breakdown in the real shape of the
   files you will be cutting through.

   During exploration, look for opportunities to prefactor the code to make
   implementation easier. "Make the change easy, then make the easy change."

# DRAFTING SUB-ISSUES

Break the PRD into **tracer-bullet** vertical slices. Each slice is a thin
vertical cut through every relevant layer (schema → API → UI → tests), NOT
a horizontal slice of one layer.

Rules:

- Each slice delivers a narrow but COMPLETE path through the relevant layers.
- A completed slice is demoable or verifiable on its own.
- Sub-issues are **flat** — a sub-issue must not itself need sub-issues. If a
  slice is too big to be a leaf, split it into multiple peer slices.
- Necessary prefactoring comes before feature work.
- Give each slice a stable key and declare its genuine blocking dependencies
  with blockedBy. Order blockers before dependents. Do not turn independent
  slices into an artificial linear chain; native blocking edges determine
  eligibility for execution.
- Each slice must stand on its own in a single agent session. A reasonable
  session can build a couple of files, write tests, and run typecheck/test.
  Do not draft slices that are unrealistic for one session.
- Preserve the PRD's constraints, exclusions, and human QA requirements.
- Follow the repository's language convention for ticket content: Chinese.

Draft the ordered list of slices, each with a title, what to build,
acceptance criteria, and blocking dependencies.

# OUTPUT

Emit the breakdown as a single `<output>` block — the last thing in your
response. The script parses it with a strict schema.

<output>
{
  "slices": [
    {
      "key": "session-create",
      "title": "short imperative title",
      "whatToBuild": "One to three short paragraphs describing this slice's end-to-end behavior, framed around what it delivers. No file paths.",
      "acceptanceCriteria": [
        "Concrete, checkable outcome 1",
        "Concrete, checkable outcome 2",
        "Tests cover the new behavior"
      ],
      "blockedBy": []
    }
  ]
}
</output>

Field rules:

- `slices` — an ordered array of at most 50 slices, blockers first.
- `key` — unique, stable English identifier: lowercase letter first, then
  lowercase letters, digits, or hyphens; at most 40 characters.
- `title` — short, imperative. No leading `feat:` / `fix:` prefix.
- `whatToBuild` — prose, not a list. Avoid specific file paths or code
  snippets. Exception: a prototype-derived snippet may be inlined when
  prose cannot encode a decision as precisely.
- `acceptanceCriteria` — non-empty array of strings. The script renders
  them as a GitHub checklist. Always include tests for the new behavior.
- `blockedBy` — keys of earlier slices that genuinely gate this slice,
  or an empty array. No missing references, self-dependencies, or cycles.

Do NOT include a `Closes` directive in any ticket body. Do not create or
modify issues, labels, dependencies, or PRs. Do not commit or push code.
The workflow posts this plan for review; a human adds
`agent:publish-tickets` to approve publication, then adds
`agent:implement` to the parent to start implementation.
