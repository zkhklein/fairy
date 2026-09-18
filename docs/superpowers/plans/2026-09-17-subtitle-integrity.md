# Subtitle integrity implementation plan

> Execution: inline in the authorized FAIRY workspace. Preserve unrelated dirty files; no deployment, paid calls, SUCCUBUSQ edits or changes to user media.

**Goal:** faithful subtitle translation with strict structural rejection, contextual translation and traceable alignment review.

**Architecture:** retain the three atomic stages and Studio workflow. Add shared pure SRT validation embedded into the two Node runners. Translation retains original IDs and immutable original context on both sides, including recursive retries. A persistent HTML/JSON source/translation review report is separate from disposable work files. Detailed request/response diagnostics and an additional model alignment review are opt-in, clearly labeled; neither replaces listening to the source audio.

**Tech stack:** existing JavaScript/TypeScript, Node built-ins, existing esbuild text bundling; no dependencies.

**Spec:** user handoff in this thread dated 2026-09-17. The historical design document is not evidence of current runtime configuration.

## Constraints

- Commands use PowerShell 7 explicitly. No deployment or paid requests in verification.
- Ordinary synthetic dialogue only. Keep original IDs/timecodes, reject malformed nonempty SRT and malformed/incomplete completions.
- Do not auto-correct place names from reference translations. Full meaning precedes wrapping/length.
- Do not persist API keys, bearer tokens, request headers or credential-bearing URLs. Reports contain subtitle text; detailed diagnostics default off.
- Unknown automatic source language blocks translation with an actionable message instead of silently using "foreign language".

## Tasks

- [x] Add failing offline integration tests in `scripts/verify_subtitle_integrity.cjs`: missing/duplicate/extra IDs, empty output, truncated completion, invalid SRT, nonsequential IDs, immutable bidirectional context after splitting, unknown language, semantic-review rejection with complete IDs, redacted diagnostics and report survival after writer cleanup.
- [x] Implement strict parsing/formatting, response checks and contextual prompts in subtitle runners. Writer validates source/translation ID and timestamp equality before writing.
- [x] Add optional review and diagnostics, with reports outside workDir and explicit configuration snapshot/reference fingerprints. Show effective future-run settings and task review location in Studio.
- [x] Fix ASR streaming language extraction and cached language handling; retain unknown as unknown and let Studio retry select a language explicitly.
- [x] Run existing ASR/LLM/writer tests, new offline tests, `pnpm typecheck`, package the four subtitle plugins and build. Inspect scoped diffs and report validation boundaries. Do not install/restart or overwrite existing user subtitles.

Result: 38 new offline tests passed; three existing atomic acceptance scripts passed; typecheck/build exit 0. Studio 0.1.3 embeds ASR/LLM/writer 0.1.2. Read-only independent review findings were fixed and covered by regression tests. Source changes remain uncommitted alongside the preserved pre-existing workspace changes. See `plugins-source/subtitle-pipeline/README.md` for operation and limitations.

## Acceptance details

The offline fake HTTP provider exercises the real spawned runner. A model response with all expected IDs but shifted content must be rejected when the optional alignment reviewer marks it shifted; a manual side-by-side report remains available. This tests enforcement and evidence, not actual model semantic accuracy. For recursive splitting the request must still contain original preceding/following text, never the already translated previous chunk.

Use fresh temporary directories and localhost servers. Assert unsuccessful cases produce no translated file; writer failures preserve an existing destination sentinel. Test diagnostic output with canary secrets echoed in fake errors/responses. Verify that a clean output with omitted `finish_reason` fails, and `stop` succeeds.

## Supplemental evidence: zero-duration source cues

Continue this same task. User and the read-only SUCCUBUSQ handoff record identify zero-duration IDs 45, 73, 74, 75 in both 411 subtitle files. Preserve IDs, text association and exact time values; no silent drop, merge or invented timing. General detection belongs in shared SRT logic, ASR fresh/cached results, Studio task warnings and persistent translation reports, including when unknown source language blocks translation. Test the supplied time values with ordinary synthetic text through writer; do not run the actual media or change SUCCUBUSQ.

- [x] Validate the supplemental warning path, all existing offline regressions and typecheck; package Studio 0.1.4 with atomic plugins 0.1.3 without replacing the earlier packages or deployed installation.

Supplement result: 40 offline tests passed; ASR (fresh and cached zero-duration warnings), LLM and writer scripts passed; typecheck exit 0; four updated plugin packages built. The normal ASR parser continues to preserve zero duration. Warnings survive an unknown-language translation failure and are shown independently of task status. The full write-through fixture preserves all four original ID/time pairs and text associations. User media and SUCCUBUSQ remain untouched.

## Follow-up evidence and fixes: 2026-09-18

Same task, using the read-only SUCCUBUSQ review document/checklist and FAIRY run `f83d3d98-e9e5-49e5-ae06-12009b2a0249`. The report has 54 cues (53 ok, 1 auto-redone), no loaded references and unusable speaker metadata. Seven requests include three review requests; the last request rewrites ID44 with before IDs38/39/40 and no after context, then no further review. Do not treat the report's old success label as proof of accuracy.

Evidence SHA-256: review.json `38dd4e26b9b080808c044db3c9b13cd3aaa1f1d3cac6ae9023db6c8532594df0`; diagnostics.jsonl `a50f4a6d6c232bbbc2784e90fb3d079e6102b716ec019e39568e90fce2349d1c`.

- [x] Reproduce ID44 missing ID43 context with ordinary synthetic dialogue; derive redo context from actual source positions and include intervening source for noncontiguous selections.
- [x] Preserve old translations/reasons and label revisions pending review, without adding a second paid review call. An ok judgment only means no listed issue was detected.
- [x] Share quality categories between review prompt and validator; include explicit references and speaker availability, require evidence for non-ok judgments. Leave audio/identity uncertainty for manual review.
- [x] Preserve revised text in checkpoints and review restored translations when enabled.
- [x] Persist task summaries and reset them on retries/new reports; independent review found and closed stale success summaries after automatic recovery and failed review.
- [x] Keep work-specific glossary patch unapplied until task scoping exists. UI explains global replacement semantics. No SUCCUBUSQ edits, user subtitle edits, installation or paid calls.

Verification results are recorded in the subtitle README. Historical entries above describe earlier stages; they are not the current version or deployment state.
