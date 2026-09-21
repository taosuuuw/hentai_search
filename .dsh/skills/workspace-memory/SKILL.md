---
name: workspace-memory
description: "Workspace workflow for this repo (hentai搜索). Priority zero: when the context window approaches 40% used, finish the step in flight, complete the memory writes, compress the context, then re-read memory/ to re-seed it. Context loads from memory/ FIRST: read memory/MEMORY.md, then the last WORKLOG entries, then LESSONS — and only then open source or run commands. During work: decompose into tasks, think in Chinese, correct any documented method that underperforms, and note the shortcut that would have saved steps. Finish: edit only three files — MEMORY.md (framework + now + decisions + contract), WORKLOG.md (what was done), LESSONS.md (what to do differently, including how to redo this round in fewer steps) — then prune and shrink back to terse English, guidance-only form."
whenToUse: "At the very start of every round in this workspace (X:\\harness\\hentai_search, or any project containing a memory/ dir) — before opening source files or running commands — again when context usage approaches 40%, and again before reporting results at the end of the round."
metadata:
  scope: workspace
  root: memory/
---

# Workspace memory workflow

Scope: this workspace only. Memory lives in `memory/` and is **not** in git. Its single purpose is that the next session does not have to re-discover anything.

If the current working directory has no `memory/`, do not apply this workflow and do not create one elsewhere.

Language rules:
- **Thinking stream during work: Chinese.** (The user reads the reasoning; keep it in Chinese.)
- **`memory/` content: English only.** Chinese is allowed only when quoting a user phrase, a code identifier, or an actual error string.
- **This skill file: English**, same as the memory it governs.
- Code comments inside the project are a separate matter — leave existing Chinese comments as they are.

## 0. Context budget guard — highest priority in any round

Watch how much of the context window is used. **When it approaches 40% used, do this before anything else in the round:**

1. **Wait for the step currently in flight to finish** — never cut a running command, browser action, or file write in half. Finish it, then switch.
2. **Finish the memory work first**: write whatever this round has already learned into `WORKLOG.md` / `LESSONS.md` / `MEMORY.md` (per §3), so it survives on disk rather than in a context that is about to be squeezed.
3. **Then run the context compaction command: `/compact`.** That is the real mechanism in this environment (`@deepseek-ai/dsh-command-compact`), **no arguments allowed** (`Usage: /compact (no arguments)`), and it only works **while the agent is idle** — a busy agent refuses with "Compaction is unavailable because this process has an active compaction, or the agent is not idle." That refusal is exactly why step 1 exists: finish the step, then compact. The user can type `/compact`; the assistant should ask for it (a slash command is not a tool the assistant can invoke).
4. **After compaction, re-read the memory files to re-seed the context**: `MEMORY.md` → last 3 `WORKLOG.md` entries → `LESSONS.md` §1 / §3 / §3b. Work from the memory afterwards, not from the old transcript.

This step outranks every other task in the round (feature work, verification, reporting). It is the only step allowed to reorder work — and only between steps, never inside one. Record in the WORKLOG entry that a budget stop happened, what was written before it, and whether `/compact` ran.

## 1. Before work — read memory first, then plan

**Context loading order: memory first, everything else second.** Do not open source, docs, or run commands to orient yourself before this pass — the memory is meant to answer the orientation questions on its own. Open other files only when the memory leaves a specific question unanswered (and then fix the memory so the next round does not need that lookup).

Read in two tiers — the always-read core is small on purpose, the experience notes are **consulted on demand**:

| Tier | What | Read |
| --- | --- | --- |
| **Always** | `memory/MEMORY.md` | framework, run commands, layout, module map, contracts, budgets, **current state, todo, and decisions already rejected** (do not "fix" them back) |
| **Always** | `memory/WORKLOG.md` | **last 3 entries only**: what changed last round and why |
| **Always (cheap)** | `memory/LESSONS.md` | **scan the headings only** — you need the index, not the text |
| **On demand** | `LESSONS.md` §1 (environment limits), §3 / §3b (recurring + DOM traps) | read the entry that matches what you are about to do: hitting a sandbox limit, a browser/DOM symptom, a repeated failure |
| **On demand** | `LESSONS.md` §4 (verification recipes) | read the exact recipe before running a measurement, a unit test, or an egress probe |
| **On demand** | `MEMORY.md` contracts / maps | read the specific contract before editing the module it governs |

Do not read `LESSONS.md` front to back "just in case" — that is the most expensive file and most of it will not apply to this round. Its headings exist so you can jump. Conversely, **skipping it is only safe until something goes wrong once**: when a symptom matches a heading, read that entry before experimenting.

Then **decompose the job into tasks before editing anything**:
- Write the task list down (todo tool) — one task per verifiable outcome, not per file touched.
- Order tasks by cost: measure first, then change, then verify. Batch independent checks in one step.
- Prefer the cheapest sufficient evidence (server-side probe / vm harness) over slow UI rounds.
- Mark tasks in progress as you work; finish a task the moment it is actually verified.
- Re-plan when a task turns out to be a different problem than assumed.

If memory contradicts the code, **code wins** — and fix the memory in the same session.

## 2. During work — record as you go, and look for the shortcut

- When you solve something by an unconventional means (bypassing a limit, temporary diagnostics, scripted verification), note it; it goes into `LESSONS.md` at finish. This kind of knowledge is lost most easily and repeated most often.
- When a method documented in `LESSONS.md` / `MEMORY.md` performs **worse than its recorded average**, treat the memory as wrong until measured again:
  - re-run the same comparison the entry describes;
  - if it is genuinely worse, fix the entry, record the measured number, and mark the previous claim superseded;
  - if the older entry is still right and this round was just anomalous, say so and leave the entry alone (do not "correct" noise).
  - Either way this belongs in the WORKLOG entry's `Traps` / `Verification` lines.
- When the user explicitly rejects an approach, write "rejected approach + reason" into `MEMORY.md` so the next session does not propose it again.
- **Track your own step count.** Notice the moment a step costs more than it should (three probes to answer one question, a screenshot sweep instead of a counter, a guess you then had to re-measure). Write down the entry point that would have answered it directly, and carry it into §3.5.

## 3. Finish — five mandatory steps, three files

Only three files exist: `MEMORY.md` (framework + now + decisions + contract), `WORKLOG.md` (what was done), `LESSONS.md` (what to do differently). Every finish step below edits one of those — no extra files.

### 3.1 Append a worklog entry (`memory/WORKLOG.md`, newest first)

Same-file shape (3–10 lines is enough):

```
## YYYY-MM-DD · one-line topic
- Goal: what the user asked (their key words, not your paraphrase)
- Changes: file → behavior changed
- Approach: key choice + why (one line)
- Traps: hit this time and will bite again
- Verification: command / page action / measured numbers
- Not done: explicitly unfinished
```

Write conclusions and traps, not process.

### 3.2 Distill lessons (`memory/LESSONS.md`)

- Check for duplicates first: improve the existing line instead of appending a synonym.
- Only keep entries that cause rework if unknown. Anything visible at a glance in the code does not belong here.
- Each entry must stand alone: "want X → doing Y fails (with the error fingerprint) → doing Z works".
- Every entry should be actionable: the next session must know what to do differently.

### 3.3 Prune stale memory

Ask of every entry:
- Describes a temporary state already implemented in code? → delete.
- Contradicts the current code? → fix it, or delete it (better absent than wrong).
- Superseded by a later conclusion? → merge into one entry.
- A completed `MEMORY.md` todo? → delete (it is not a progress bar).
- Only true for one past environment? → delete, or note its scope inside the entry.

### 3.4 Shrink to guidance-only + check read cost

Memory exists to steer an AI reader, not to document history. **The budget is reading time and comprehension cost, not a byte count** — a bigger memory is fine when every line earns its place; it is not fine when a session has to wade through prose to find the one entry it needs.

Recompress:
- facts and directives over explanation; tables and labeled lines over nested prose;
- minimal indentation, short lines, no wrapping decoration;
- one entry = one line where possible; a heading index that lets a reader jump without reading the section;
- delete rationale that no longer changes any action; keep the "do not do X" warnings.

Cut in this order when a file stops being skimmable:
1. `WORKLOG.md` keeps the last 3 entries; older ones collapse into one condensed-history block (this file is allowed to be the longest — it is read only 3 entries deep).
2. `LESSONS.md` drops entries that no longer cause rework, and merges entries with the same trigger (this is the file read by heading-scan, so keep its headings precise).
3. `MEMORY.md` drops explanation, never facts, contracts, or decisions (this one is read every round, so it is the one worth being strict about).

Size check (PowerShell) — use it as a smell, not a gate:
`(Get-ChildItem memory -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1KB`

### 3.5 Record the simplifications (how to do this round in fewer steps)

Do not finish without answering: **"if the next session had to redo this round, what would make it shorter?"** Write that into `LESSONS.md` (as a recipe) or `MEMORY.md` (as a contract/entry point). Prefer naming the exact tool over prose, e.g.:
- "cover problems: use `?coverdiag=1` instead of screenshot counting" (the ledger already exists for this);
- "pure frontend logic: `tools/concept-check-shim.js` + `vm` harness instead of browser rounds" (already exists for this);
- "new stacking/dedupe rule: call the exported `R.tagSet/tagsAlike/nameLike/titleShape` probes instead of reading the pipeline";
- "one upstream suspicious: probe it through `/api/proxy` before touching the adapter".

Also record the reverse when relevant: which previous step turned out to be unnecessary (a manual sweep a diagnostic flag replaced, a browser check a harness replaced, a rule that replaced trial and error). If a round leaves no cheaper path behind, it left half its value behind.

Size is governed by reading cost, not by a byte target: the always-read core (`MEMORY.md` + last 3 WORKLOG entries + the LESSONS heading scan) must stay skimmable in one pass; the notes part may grow as long as every line still changes an action. The KB number is a smell, not a gate:
`(Get-ChildItem memory -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1KB`

## 4. Boundaries

- `memory/` belongs to this workspace only. Do not copy it elsewhere, do not commit it, do not leak its paths into release artifacts. It is already listed in both `.gitignore` and `.git/info/exclude`; if `git status` shows it, fix the ignore rules first.
- Keep the file count at three. Merging/adding files costs tool calls every session; extend an existing file instead.
- **Size = reading cost, not a byte target.** The always-read core (`MEMORY.md` + last 3 `WORKLOG.md` entries + the `LESSONS.md` heading scan) must stay skimmable in one pass; the notes may grow while every line still changes an action.
- Do not grow memory to "record everything". A memory nobody finishes reading is not memory.
- Do not write unconfirmed guesses as facts. Mark them as unconfirmed.
