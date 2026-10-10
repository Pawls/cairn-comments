# Benchmark: do AI comments pay?

Whether an agent working in a checkout with Cairn's AI comments spends fewer tokens, less
time, or succeeds more often than the same agent on the committed code alone. One session
cannot show this: what it would have cost without the comments is never observed. Paired
runs of the same tasks with and without the comments are the source of the number.

The harness is `scripts/benchmark/`, the tasks are `benchmark/tasks.json`, and the frozen
comments are `benchmark/comments/<repo>/`.

## Method

**Arms.** Every run of a task starts from the same commit; only the agent's checkout
differs.

- **none:** the committed code, in a plain git worktree.
- **comments:** a worktree of the same commit in a clone set up with `cairn init
  --private`, holding the frozen comments, so the checkout places them in the files. The
  branch is byte for byte the same as in **none**. Claude Code runs also get the
  `claude-code` post-edit hook, as `cairn init --hooks claude-code` installs it, so that
  arm pays the hook's cost too.
- **summaries** (comments plus outlines) comes later, for the decision on the outline and
  read-hook features.

**Frozen comments.** For each repository, one agent session writes comments at a base
commit that precedes every task's start (`npm run benchmark -- annotate`, prompt in
`benchmark/annotate-prompt.md`). It never sees the tasks, and the session is refused if it
changes code. The sidecars it leaves are copied into `benchmark/comments/<repo>/` and
committed, and every comments-arm run places that same set at its task's start commit, as
an owner's later commits reach an agent worktree.

**Tasks.** Nine tasks from real history, each verified failing at its start and passing at
its solution:

| Repository | Fix | Feature | Question |
| --- | --- | --- | --- |
| cairn-comments (TypeScript) | 4 | 0 | 1 |
| pallets/click (Python) | 2 | 1 | 1 |

An edit task's `start` precedes both the fix and any commit that adds its test (this
repository commits the failing test first). After the run, the solution commit's
`testFiles` are checked out over the agent's work and the task's `testCommand` runs;
exit 0 is success. A question is graded by its `answerKey`: regular expressions a correct
answer must all match, ignoring case, written loosely enough for a paraphrase. The prompt
describes a symptom or a feature as a user would, without naming the fix or the test.

**Model.** Qwen3.8-Flash-Next (IQ2_XS) served locally by Strata, chosen 2026-10-09 so the
runs cost nothing and can repeat freely; [plans/benchmark-runs.md](plans/benchmark-runs.md)
runs them in overnight batches. The result is for that model and may not carry over to
Claude. The harness also runs against the Anthropic API (the default `--provider`).

**Harnesses.** Claude Code (`claude -p --output-format stream-json`) and pi (`pi -p --mode
json`), the same model in both. Hermes is out: its persistent memory would carry answers
between runs. pi has no Cairn hook adapter, so its comments arm tests the filter alone. The
comparison is between arms within one harness, never across harnesses.

**No memory between runs.** Each run gets a fresh clone, a fresh harness home
(`CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`), and an API key (any value, for a local
server); every `CLAUDE*`,
`ANTHROPIC*`, and `PI_*` variable of the machine owner is removed. Git runs with its own
global config and ignore file and without the system config, and Cairn with its own CLI
home. The repository's own AGENTS.md is part of the start state and identical in both arms.
Harnesses read AGENTS.md and CLAUDE.md from every parent directory, so the work directory
must have none above it; the runner refuses one that does. On Windows that rules out
anything under the home folder when `~/.claude` exists; use a short path such as `C:\cb`.

**Order and repetitions.** Five runs per task per arm, in an order shuffled by a fixed
seed, so time-of-day and rate-limit effects spread over both arms. Neither harness exposes
temperature; both run at their defaults. A run times out after 30 minutes.

**Local models.** Any `--provider` other than the Anthropic API is a local server serving
`--model` under that name through the Messages API. Claude Code's side calls (titles,
summaries, subagents) go to that model too, and pi gets a provider of its own for it. A run
in which the server failed a call (a 5xx), or no model call succeeded at all, says nothing
about the agent: it is left with `error.txt` instead of a result, retried by the next batch,
and two in a row end a batch.

**Capture.** A recording proxy (`scripts/benchmark/proxy.ts`) sits between the harness and
the API. It forwards each request unchanged (asking for an uncompressed response) and logs
every model call with the provider's own usage fields and the tool calls in the response.
The harness's own totals (Claude Code's result line, pi's per-message usage) are kept too,
and the report states the largest gap between the two.

**Per run.** Input tokens split into uncached, cache read, and cache write; output tokens;
turns (calls to the run's model, not side calls such as titles); tool calls by name;
distinct files read; wall time; cost as the harness reports it; success. In the comments
arm, the bytes the placed comments add to each file, and of those the bytes in files the
agent read (a ranged read counts the whole file), as the cost side.

**Report.** Per arm, the median and interquartile range of each measure. Per task, each
arm's median and the comments arm's change, then the median of those per-task changes.
Pairing by task keeps the spread between easy and hard tasks out of the comparison.

**Kill criteria** (from the v2 plan): if **comments** is not better than **none** on tokens
or success, the product claim is rethought before publishing. If **summaries** saves under
20% of tokens over **comments** on the question tasks, the outline and read-hook features
are struck.

## Running it

On this machine, batches run unattended through `scripts\benchmark\batch.ps1`, as
[plans/benchmark-runs.md](plans/benchmark-runs.md) describes. By hand, `npm run benchmark
--` builds the CLI, then runs `scripts/benchmark/main.ts`:

```sh
P="--work /c/cb --model qwen3.8-flash-next-iq2_xs --provider http://127.0.0.1:8411"
npm run benchmark -- annotate --repo cairn-comments $P
npm run benchmark -- annotate --repo click $P
npm run benchmark -- run $P --stop-at 07:00               # Claude Code
npm run benchmark -- run $P --harness pi --stop-at 07:00
npm run benchmark -- status --work /c/cb                   # what is done and left
npm run benchmark -- report --work /c/cb
```

Against the Anthropic API, leave out `--provider`, name a Claude model, and set
`ANTHROPIC_API_KEY`.

A run that already wrote `result.json` is skipped, so an interrupted benchmark resumes;
`--only <task,...>` and `--reps` narrow it. Runs take 5 to 20 minutes each, so `--shard
1/3`, `2/3`, and `3/3` in three terminals split the shuffled queue three ways. Parallel
runs compete for the CPU (`npm ci`, test runs), which adds noise to wall time; the shuffle
spreads it over both arms. Each run keeps `calls.jsonl` (the proxy log),
the harness output, `setup.log`, `test.log`, and `result.json` under
`<work>/runs/<harness>/<task>/<arm>-<rep>/`; `--keep` also keeps the checkouts.

The click setup uses `uv`; the cairn-comments setup runs `npm ci`. `--provider <url>`
points the proxy at a stand-in for the API, which is how the harness was exercised end to
end without spending: annotate, both arms, grading, and the report, on both harnesses.

**Cost against the Anthropic API**, should the benchmark be repeated on Claude. At 2026-10 list prices per million tokens (Opus 5.5 $4 input, $20 output, $0.20
cache read; Haiku 5.5 $0.10 input and $0.50 output up to 100K-token prompts, five times that
beyond), an agent run of 30 to 50 turns is expected at roughly $0.50 to $2 on Opus and $0.05
to $0.20 on Haiku, so 90 runs per harness at roughly $50 to $150 or $5 to $20, plus the two
annotating sessions. The first real runs replace these estimates. Write the comments with
the strongest model whatever runs the tasks: they are the treatment, written once.

## Results

Not run yet.
