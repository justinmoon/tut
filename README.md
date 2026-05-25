# tut

Standalone prototype for generating code-change tutorials that can be reviewed in
[Hunk](https://github.com/modem-dev/hunk) without forking Hunk.

It follows the small `pika-git local` pattern:

1. collect a unified git diff
2. ask an agent CLI for strict JSON
3. validate and render a Markdown tutorial
4. render a Hunk `--agent-context` sidecar with inline hunk notes

## Usage

```sh
tut HEAD~5..HEAD --about "session daemon changes"
```

By default this writes a durable review item under:

```text
~/.local/share/tut/reviews/<review-id>/
```

For the initial rename, `tut` will keep using an existing
`~/.local/share/hunk-tutorial` store when present so older reviews stay visible.

Each item contains:

- `tutorial.md`
- `tutorial.agent.json`
- `manifest.json`

Open the same range in Hunk with the generated sidecar:

```sh
hunk diff HEAD~5..HEAD --agent-context tutorial.agent.json --agent-notes
```

## Inbox

Generated tutorials can be browsed with:

```sh
tut inbox
```

The inbox uses OpenTUI, the same terminal UI stack Hunk uses. Opening Hunk or
`$PAGER` suspends the inbox and resumes it when the child tool exits.

Keys:

- `j` / `k` or arrow keys: move selection
- `Enter`: open the selected review in Hunk with its sidecar notes
- `c`: open the selected review's agent chat session
- `m`: open the selected Markdown tutorial in `$PAGER`
- `x`: mark the selected review done
- `u`: restore the selected review from done
- `r`: retry the selected failed or stale review
- `d`: archive the selected review
- `q`: quit

Plain commands are also available:

```sh
tut list
tut list --all
tut open <review-id>
tut chat <review-id>
tut retry <review-id>
tut done <review-id-or-commit>
tut undone <review-id-or-commit>
tut archive <review-id>
```

Done reviews are hidden from the default inbox and list. Use `--all` to include
them again.

## Background Generation

Post-commit hooks can enqueue tutorial generation without blocking the commit:

```sh
tut enqueue HEAD --cwd /path/to/repo
```

`enqueue` creates an inbox item immediately with `status: generating`, starts a
detached worker, and exits. The inbox polls the durable review store while open,
so queued items update to `ready` or `failed` in place. Failed or stale jobs can
be retried:

```sh
tut jobs
tut retry <review-id>
```

## Providers

By default the CLI uses `claude` when present, then `codex`, then falls back to a
local heuristic summary.

```sh
tut HEAD~5..HEAD --provider claude --model sonnet
tut HEAD~5..HEAD --provider codex --model gpt-5.1-codex-max
tut HEAD~5..HEAD --provider none
```

`claude` is called like Pika does:

```sh
claude -p --output-format json --max-turns 1 --tools ""
```

`codex` is called through non-interactive exec with structured output:

```sh
codex exec --output-last-message <tmp> --output-schema <tmp-schema> -
```

## Agent Session Provenance

You can record the session that wrote the code:

```sh
tut HEAD~5..HEAD --source-session codex:<session-id>
```

That provenance is included in the prompt and Markdown. To fork the originating
session for follow-up review:

```sh
tut fork codex:<session-id> "explain the riskiest part of this change"
tut fork claude:<session-id> "walk me through this implementation"
```

Codex uses `codex fork <session-id> <prompt>`. Claude uses
`claude -r <session-id> --fork-session <prompt>`.

To jump into a review's chat session from the shell:

```sh
tut chat
tut chat <review-id>
```

`chat` resumes a recorded fork session when one exists. If a review only has the
source session that wrote the code, it opens a provider fork so the original
session is not disturbed.

When you already have a forked Codex session and want tutorial generation to use
that mutable fork, pass both ids:

```sh
tut HEAD~1..HEAD \
  --provider codex \
  --source-session codex:<original-session-id> \
  --fork-session codex:<fork-session-id>
```

## Options

```text
--about <text>              Focus the tutorial on a concern or feature
--base <ref>                Default range base when no range is passed
--include-uncommitted       Append staged and unstaged changes to the input
--out <path>                Markdown output path
--sidecar-out <path>        Hunk sidecar output path
--tutorial-json <path>      Use an existing tutorial JSON response
--provider <name>           claude, codex, or none
--model <name>              Provider model name
--max-diff-chars <n>        Diff prompt budget
--source-session <ref>      codex:<id> or claude:<id>
--fork-session <ref>        forked codex:<id> to resume for generation
--cwd <path>                Git repo path
```

## Current Limits

- The natural-language description is a focus hint, not semantic commit search.
- The sidecar maps step evidence to hunk headers; richer line-level notes would
  need the model schema to emit explicit ranges.
- `fork` is intentionally interactive because the provider CLIs own session UX.
