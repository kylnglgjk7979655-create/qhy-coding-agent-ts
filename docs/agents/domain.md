# Domain Docs

How engineering skills should consume this repo's domain documentation.

## Before exploring, read these

- `GLOSSARY.md` at the repo root, or `GLOSSARY-MAP.md` if it exists.
- `docs/adr/` for decisions relevant to the area being changed.

If these files do not exist, proceed silently. The domain-modeling skill creates them when terms or decisions are resolved.

## Layout

This is a single-context repo: one root `GLOSSARY.md` and `docs/adr/`.

## Use the glossary's vocabulary

Use terms as defined in `GLOSSARY.md` in issue titles, refactor proposals, hypotheses, and test names. If a needed term is missing, note the vocabulary gap for domain modeling.

## Flag ADR conflicts

If a proposed change contradicts an ADR, surface the conflict explicitly before overriding it.
