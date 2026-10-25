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

**Tasks.** Nine tasks from real history on these two repositories (the large-repository
test has its own ten, § Large repository), each verified failing at its start and passing at
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
runs cost nothing and can repeat freely;
[plans/archived/benchmark-runs.md](plans/archived/benchmark-runs.md) ran them in overnight
batches. The result is for that model and may not carry over to
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
Pairing by task keeps the spread between easy and hard tasks out of the comparison. The
median per-task change carries a 95% bootstrap interval: each of 10,000 iterations, with a
fixed seed, resamples every task's runs within each arm, so the interval shows run-to-run
noise for this task set. A harness whose runs all report a cost of 0 gets no cost column.

**Kill criteria** (from the v2 plan): if **comments** is not better than **none** on tokens
or success, the product claim is rethought before publishing. If **summaries** saves under
20% of tokens over **comments** on the question tasks, the outline and read-hook features
are struck.

## Running it

On this machine, batches run unattended through `scripts\benchmark\batch.ps1`, as
[plans/archived/benchmark-runs.md](plans/archived/benchmark-runs.md) describes. By hand, `npm run benchmark
--` builds the CLI, then runs `scripts/benchmark/main.ts`:

```sh
P="--work /c/cb --model qwen3.8-flash-next-iq2_xs --provider http://127.0.0.1:8411"
npm run benchmark -- annotate --repo cairn-comments $P
npm run benchmark -- annotate --repo click $P
npm run benchmark -- run $P --stop-at 07:00               # Claude Code
npm run benchmark -- run $P --harness pi --stop-at 07:00
npm run benchmark -- status --work /c/cb                   # what is done and left
npm run benchmark -- report --work /c/cb

# the large repository (own comments, no Cairn): build the arm commits once, then run
B="--work /c/cbb --tasks benchmark/boxel-tasks.json --model qwen3.8-flash-next-iq2_xs --provider http://127.0.0.1:8411"
npm run benchmark -- prepare --repo boxel $B --source <local clone>
npm run benchmark -- run $B
```

Against the Anthropic API, leave out `--provider`, name a Claude model, and set
`ANTHROPIC_API_KEY`.

A run that already wrote `result.json` is skipped, so an interrupted benchmark resumes;
`--only <task,...>` and `--reps` narrow it. Runs take 5 to 20 minutes each, so `--shard
1/3`, `2/3`, and `3/3` in three terminals split the shuffled queue three ways. Parallel
runs compete for the CPU (`npm ci`, test runs), which adds noise to wall time; the shuffle
spreads it over both arms. Each run keeps `calls.jsonl` (the proxy log),
the harness output, `setup.log`, `test.log`, and `result.json` under
`<work>/runs/<harness>/<task>/<hash>/`, a name that hides the arm from the agent working
in it (`result.json` records the arm); `--keep` also keeps the checkouts. `run` and `status`
refuse a work directory from before the names were hashed (`<arm>-<rep>`); give them a new
`--work`.

The click setup uses `uv`; the cairn-comments setup runs `npm ci`. `--provider <url>`
points the proxy at a stand-in for the API, which is how the harness was exercised end to
end without spending: annotate, both arms, grading, and the report, on both harnesses.

**Cost against the Anthropic API**, should the benchmark be repeated on Claude. The 2,630
model calls of the 90 Claude Code runs on Strata, priced at 2026-10 list prices (new prompt
tokens as 5-minute cache writes, which Claude Code's prompt caching makes them; Haiku 5.5's
over-100K rate for the 61 calls whose prompt passed it), come to:

| Model | Per run, median | Largest run | 90 runs |
| --- | --- | --- | --- |
| Opus 5.5 ($5 cache write, $0.20 cache read, $20 output) | $1.02 | $5.16 | $99 |
| Sonnet 5.5 ($2.50, $0.10, $10) | $0.51 | $2.58 | $50 |
| Haiku 5.5 ($0.125, $0.01, $0.50 up to 100K-token prompts; five times that beyond) | $0.03 | $0.37 | $3.61 |

Claude would take its own number of turns and its tokenizer counts differently, so treat
these as the order of magnitude. Cache reads are about 96% of the input tokens, so the
cache-read price decides the bill. Write the comments with the strongest model whatever runs
the tasks: they are the treatment, written once.

## Deep runs

The deep-context benchmark ([plans/benchmark-deep-context.md](plans/benchmark-deep-context.md))
asks whether comments help an agent that is deep into a long session. Its probe set is
[benchmark/deep-tasks.json](../benchmark/deep-tasks.json): eight probes on BoxelBuilder and
the warm-up chains they fork, all at one start commit.

```sh
D="--work /c/cbd --tasks benchmark/deep-tasks.json --model qwen3.8-flash-next-iq2_xs --provider http://127.0.0.1:8411"
npm run benchmark -- prepare --repo boxel $D --source <local clone>
npm run benchmark -- run $D --depths fresh,deep --reps 3
npm run benchmark -- status $D --depths fresh,deep --reps 3
```

**Depths.** `--depths fresh` (the default) starts each probe in an empty session and a
checkout of its own. `--depths deep` forks each warm-up chain instead: the chain's prompts
run once per harness and arm, in one session, before the first probe that forks it, and
every probe then forks that session as the chain left it. `--depths fresh,deep` plans both,
so each probe runs once fresh and once per chain for every arm and repetition. `--chains
<chain,...>` narrows the chains. A probe set names its own chains and refuses `--warmups`; a
round's task file takes them from `--warmups` (default `benchmark/warmups/`). The probe set
is prepared once, under the id `deep`, which verify-probes builds too.

**Forks.** A fork sees the warm-up's history and nothing of another fork's. Before each
probe the warm-up's checkout, harness configuration, and sessions are put back from a
snapshot taken when the chain finished, so probes share nothing but the warm-up. The
checkout cannot move: the session's tool calls name its files by absolute path.

**Probe kinds.** Each kind has its own grade in `result.json`'s `grade`:

| Kind | Tools | `passed` means | Also recorded |
| --- | --- | --- | --- |
| predict | read-only | the final answer's last `ANSWER:` line matches `expected` | `missing`, `rubric` |
| locate | read-only | the final answer matches every answer-key pattern | `missing` |
| change | all | the hidden tests pass, with any kept tests put back to the arm's commit | `testExit`, `rubric`, `test.log` |

Read-only runs get an allowlist: Claude Code `--tools Read,Grep,Glob`, pi `--tools
read,grep,find,ls`. With a shell, a prediction could be run instead of read. The rubric is
a secondary score: which of the probe's patterns the final answer states, never part of
`passed`.

A read-only fork declares a different tool list than the warm-up did, and the tools come
first in the prompt, so its first call misses the prompt cache and prefills the whole
warm-up again. Both arms pay this alike, so the per-probe comparison holds, but a deep
prediction's or location's wall time and cache split are not comparable with a deep
change's.

**What a result records.** Beside the fields every run has, `depth` (`fresh` or `deep`),
`chain` for a deep run, and `metrics.firstCallContext`, the context of the probe's first
agent call, which at depth `deep` holds the whole warm-up. The proxy log tags each call
`warmup` or `probe`, and a run's metrics count only its probe calls.

**Layout.** Warm-ups live under `<work>/warmups/<harness>/<hash>/` (the checkout, its
snapshot, `calls.jsonl`, one `harness-<n>.jsonl` per prompt, and `warmup.json` with the
session id, each prompt's exit, the wall time, and the final context). Runs live under
`<work>/runs/<harness>/<probe>/<hash>/`; a deep run's directory holds no checkout of its
own. Every hash hides the arm, and `warmup.json` names no arm, since it sits beside the
agent's checkout. Only `result.json` records the arm.

## The notes loop

D7 of the deep-context plan asks whether a note one agent leaves while it works saves the
next agent from working the same thing out again. A notes set is a probe set with `pairs`
(each a writer probe and the reader probes that take its notes), `prepend` (the file whose
text goes at the top of AGENTS.md in the notes arm, [benchmark/notes-prepend.md](../benchmark/notes-prepend.md))
and optional `variants` (named groups of readers, each reported on its own).

```sh
L="--work /c/cbn --tasks benchmark/notes-tasks.json --model swift-qwen3.8-27b-dflash2 --provider http://127.0.0.1:8410"
npm run benchmark -- prepare --repo boxel $L --source <local clone>
npm run benchmark -- loop $L --reps 2 --bare-writers 1 --writers-only   # the writers first, for gate GN
npm run benchmark -- loop $L --reps 2 --bare-writers 1 --writer-timeout 60
npm run benchmark -- loop-report $L
```

**Arms.** Both start from the stripped commit (`none`). In `bare`, AGENTS.md holds only the
repository's agent notes and there is no Cairn. In `notes`, the prepend sits above them and
the clone is in Cairn private mode with the Claude Code hook; a writer starts with an empty
store, and a reader with the frozen notes of the same repetition of its writer. The AGENTS.md
is committed into the clone's one parentless commit, so `git status` is clean in both arms.

**Order.** Repetition by repetition and pair by pair: the writer in `notes` (its readers need
its notes), the writer in `bare` for the first `--bare-writers` repetitions (what writing notes
costs), then each reader in both arms, in an order that alternates by repetition. A reader in
`notes` whose writer has no result yet is skipped and left for the next batch.

**What a result records.** `loop` in `result.json`: the role, arm and writer; for a writer in
`notes`, `left` (its entries per file after a final `sync`, frozen into
`<work>/notes/<harness>/<writer>-<rep>/`); for a reader in `notes`, `given` (the writer's
entries per file, the comments Cairn placed per file, and how many were placed `[stale?]`).
The writer's code changes are not kept: a note in a function the writer changed places stale
or not at all on the original code; `--carry` avoids that: the writer in `notes` commits its work (through Cairn's clean filter, so without the notes) as one parentless commit, and every reader of the repetition starts from it, in both arms. Runs live under `<work>/loop/<harness>/<task>/<hash>/`.

**Report.** `loop-report` writes `<work>/loop-report.md`: per reader, each arm's pass rate,
mean tokens (context added past the first call, plus output, as in D4b) and wall time, and
their ratio; over readers, the geometric mean of the notes / bare ratios with a 95% bootstrap
interval and D7's decision rule; the writers' costs; and the whole loop per pair.

## Results

**Notes one agent leaves for the next (2026-10-24, Swift 1.5 Qwen3.8-27B on Claude Code): they
saved the next agent nothing.** A writer did a real task in Cairn's notes mode and its work was
committed; a fresh reader then did a task on the same functions with the writer's notes placed,
or without them. Over 8 readers × 2 repetitions, the notes readers spent 1.06× the tokens counted
once (95% interval 0.97 to 1.15; 1.12× on D4b's column, which counts output twice), took 1.26×
the wall time (0.99 to 1.54), and passed 14 of 16 against 15 of 16. One water pair went the other way (0.85 and 0.88, and one run the notes got right where
bare did not); one felling note misled its reader into a failure. Numbers and causes:
[plans/benchmark-deep-context.md § D7](plans/benchmark-deep-context.md#d7).

**Deep context (2026-10-21, IQ3_XXS on Claude Code): the agent was not lost, and comments
cost tokens.** After a 118,000-token warm-up of real work the stripped arm still solved all
eight probes, more cheaply than fresh, so the deep-context gates failed and the matrix did not
run. On seven of the probes at fresh depth, the repository's own comments, inline in the agent's
checkout, cost 18% more tokens (geometric mean ratio 1.18, 95% interval 1.04 to 1.36) with
every run passing. Numbers, causes and the next conditions to test are in
[plans/benchmark-deep-context.md § D4](plans/benchmark-deep-context.md#d4) and
[§ D4b](plans/benchmark-deep-context.md#d4b).

**On a large repository, the repository's own comments made no measurable difference to
success or to input tokens** ([§ Large repository](#large-repository-boxelbuilder)):
every run passed in both arms, and the comments arm's median per-task change in input tokens was
+20.7% with a 95% bootstrap interval of -15.1% to +30.6%. It was faster on 7 of 10 tasks, by
a median 8.8% (-21.0% to +4.9%). The small-repository result follows.

**On two small repositories, comments made no measurable difference.** Every Claude Code run
passed in both arms, so success could not discriminate, and the comments arm used 15.8% more
input tokens (median per-task change; the 95% bootstrap interval runs from -5.4% to +47.2%).
On pi the change was -2.0% (-18.5% to +35.8%) with 36 of 45 runs passing against 35 of 45.
Both intervals include zero, so the runs show neither a saving nor a cost. The kill criterion
is not settled by this alone: both repositories are small enough to read in a few files, which
is where comments should help least (§ What this does not show). The large-repository
test below was the next step.

### Setup

- **Model:** Qwen3.8-Flash-Next IQ2_XS (`qwen3.8-flash-next-iq2_xs`), served by Strata
  v0.1.39 (commit `6f32ec0`) at 262k context, int8 KV cache, speculative decoding on.
- **Dates:** Claude Code runs 2026-10-10 (three batches), pi runs 2026-10-11 (two batches).
- **Harness code:** every batch built from `benchmark-harness` at or after `c753e1a`; the
  harness, the tasks, and the CLI did not change between the first and last batch.
- **Frozen comments:** cairn-comments 130 comments in 47 sidecars, click 99 in 17, written on
  2026-10-10 by an annotate session on the same local model.

### Deviations from the method

- **The comments were written by the model under test, not the strongest model** that the
  cost section recommends: the owner chose a local model for every session, the annotating
  ones included. A spot check of ten comments per repository found each one described the
  code below it, but a stronger model's comments might carry more.
- **The calibration runs count toward the matrix.** The first night ran the none arm once
  per task (9 runs) before the comments existed, to size the matrix; those are the `none-1`
  runs of Claude Code, and pi's smoke run is its `sidecar-merge-placement` `none-1`. They
  ran outside the shuffled order, ahead of the rest.
- **One batch per harness ran in the daytime** (Claude Code 2026-10-10 from 11:12, 50 runs;
  pi 2026-10-11 from 10:14, 13 runs) while the machine could be in use, which adds noise to
  wall time; the shuffle spreads it over both arms.
- **Timeout unchanged at 30 minutes.** One pi run (none arm) timed out; no Claude Code run
  did.
- **Cost is not money.** Strata charges nothing. Claude Code prices a model it does not know
  at $5 / $25 / $0.50 per million input, output, and cache-read tokens, so its cost column
  is a weighted token count. pi reports 0, and the report leaves the column out for it.

### What this does not show

- **Whether comments help on a large codebase** (the large-repository test below answers
  this for one). Non-test source is about 8,200 lines in
  cairn-comments and 12,700 in click, and agents read a median of 4 or 5 files per run. When
  a search and a few reads find the answer, comments can only add bytes to read. They are
  expected to pay where the code is too large to explore cheaply.
- **Whether comments help an agent find its way.** Every edit prompt was a precise bug
  report with a reproduction or the exact error message, and the click prompts named the API
  involved, so the prompt did the navigation that comments would otherwise help with.
- **Whether comments raise success.** Claude Code passed every run in both arms, so the
  tasks were below the model's ceiling and only tokens and time could move.
- **Whether comments help understanding.** Only 2 of the 9 tasks were questions, too few to
  say anything on their own.
- **Whether well-written comments help.** The comments were written after the fact by the
  quantized model under test, not by agents while doing the work, and there were few of them:
  one comment per 130 source lines in click.
- **Whether the result holds for code the model has not seen.** click is a widely used
  library and likely in the model's training data, so its comments tell the model less than
  they would about private code.
- **Whether it carries over to Claude.** Every run used one local model.

### Large repository (BoxelBuilder)

The owner chose BoxelBuilder (a Python voxel-world editor; 771 Python files, 14.1 MB at the
chosen commits, 2026-10-11), on the same Strata model so the two results compare. Its own
comments are the treatment: they add 2.4 MB, 17% of the bytes of Python source, written as
the code was developed rather than after the fact. The arms differ only in those comments:

- **comments (as committed):** the task's start commit as it is.
- **none (stripped):** the same commit with every comment removed except functional ones
  (shebangs, encoding lines, `# noqa` in any case, `# type:`, `# pragma`, `# fmt:`, and the
  `pylint:`, `pyright:`, `pyre-`, `mypy:`, `isort:`, `ruff:`, `yapf:`, `autopep8:`, and `nosec`
  directives; BoxelBuilder's only directives are lowercase `# noqa`). Docstrings stay in both
  arms, and so does a byte-order mark.
  [strip_comments.py](../scripts/benchmark/strip_comments.py) removes them with Python's `tokenize` and
  refuses to write a file whose `ast.dump` differs from the original's; all 771 files parsed
  and passed. Comments inside triple-quoted strings (shader source) are not comments to
  Python and stay.
- **in both arms:** every markdown file, `.claude/`, `.agents/`, `.serena/`, `.pawl/`, `.mcp.json`,
  and `.coderabbit.yaml` are removed, since committed plans and handoffs can describe the fix a
  task asks for. A one-line README stub stays because the packaging file names it. An identical,
  minimal AGENTS.md (the task file's `agentNotes`) says only how to run a test file, and a
  CLAUDE.md imports it.
- **No history:** `npm run benchmark -- prepare --repo boxel --source <clone>` builds each
  task's two arm commits as parentless commits in the mirror, and the run clones only that
  branch, with `--no-local` so no other object or tag comes along, and no remote. An agent
  cannot read the original comments or the solution out of git. Both arm commits have the
  message `Initial commit`, and the clone keeps no branch but the agent's `bench`, so git
  does not say which arm a run is in. The solution's test files are read from the mirror at
  grading time. `<work>/prepared/<repo>.json` records each task's start commit and agent
  notes, and `run` refuses a task whose entry no longer matches the task file. Preparing all
  ten tasks takes about 3 minutes; rebuilt with these rules, all 20 arm trees are identical
  to the ones the recorded round ran on.
- **The recorded round had a weaker clone.** Its runs cloned by local path, which copied the
  mirror's whole object store and its 16 tags, so the original history was reachable from
  `git tag` or `git log --all`. A check of all 100 transcripts found no run that looked: the
  agents ran only `git log -N`, `git diff`, `git status`, `git stash list`, and `git show` on
  their own commit. Its commits did name the arm (`<task>: the code without comments`, or
  `as committed`), and 11 none runs and 7 comments runs printed that subject with `git log`
  or `git show --stat`. The arm is also in every run's directory path
  (`runs/<harness>/<task>/<arm>-<rep>/agent`), in both rounds.
- **No Cairn at all:** neither arm uses the filter or the hook, so this tests the
  repository's own comments, not the tool.

Tasks ([boxel-tasks.json](../benchmark/boxel-tasks.json)): five fixes from real history, each verified to fail on
its new tests at its start commit in both arms and to pass at its solution commit, and five
questions graded by answer key. The keys were tightened after the round so that a phrase like
"First, ..." or a stray number no longer passes; all 50 recorded answers pass the new keys,
so the question results stand. The edit prompts describe a symptom as a user would, but
the tests need a few contracts spelled out (a warning text, a return value), so some
name an identifier or message. Setup is `uv venv` and an editable install of the project
with its dev extras on Python 3.13; a task's test command is one or two pytest files run
serially. Five repetitions per task per arm, Claude Code only, shuffled with seed 1.

**Calibration did not leave room.** The plan required the stripped arm to fall below a full
pass on a calibration run. One run of each task in the stripped arm (the `none-1` runs, which
count toward the matrix, as in the small-repository runs) passed 10 of 10, in 0.4 to 11.5
minutes. The tasks were not made harder: success is at its ceiling in both arms, so only
tokens, turns, and time can move, as for Claude Code on the small repositories.

**Deviations.** Claude Code only; pi did not run on this repository. The Strata front end
was stopped once during setup by a stray process kill and restarted with its own start
script before any run; the matrix then ran in one unattended batch, 2026-10-14 02:34 to
08:35, with no errors and no timeouts. The task selection is the author's: five fixes and
five questions chosen from one repository's recent history, not a sample of all work.

The report (`npm run benchmark -- report --work /c/cbb`, a work directory holding only these runs):

### claude, BoxelBuilder (qwen3.8-flash-next-iq2_xs)

Median (interquartile range) per run.

| Arm | Success | Input tokens, all | Uncached input | Cache read | Output | Turns | Tool calls | Files read | Wall time (s) | Comment bytes read |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| comments | 50/50 | 297,770 (128,467 to 1,226,312) | 32,875 (25,444 to 43,565) | 266,674 (104,139 to 1,182,492) | 5,286 (1,486 to 18,235) | 11 (5 to 31) | 14 (6 to 31) | 3 (1 to 4) | 65 (31 to 316) | 15,782 (6,075 to 25,610) |
| none | 50/50 | 416,583 (136,660 to 1,237,994) | 31,872 (25,611 to 44,029) | 378,321 (111,919 to 1,201,901) | 6,423 (2,026 to 16,032) | 12 (6 to 31) | 14 (8 to 33) | 3 (2 to 4) | 78 (33 to 549) | 0 (0 to 0) |

The pooled medians favor the comments arm (-28% input tokens), but pooling mixes easy and hard
tasks. Per task, each arm's median and the comments arm's change against none:

| Task | Kind | Input tokens, all, none | comments | change | Wall time (s), none | comments | change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bad-block-row-half-loads | fix | 1,578,440 | 2,109,856 | +33.7% | 674 | 469 | -30.5% |
| bad-command-resets-database | fix | 2,207,895 | 1,531,114 | -30.7% | 611 | 516 | -15.6% |
| spaced-effect-ids | fix | 1,277,193 | 1,784,509 | +39.7% | 512 | 567 | +10.7% |
| spaced-variable-source | fix | 795,620 | 978,693 | +23.0% | 552 | 162 | -70.7% |
| ray-inside-event-box | fix | 259,423 | 352,686 | +36.0% | 90 | 95 | +5.9% |
| behavior-transitions | question | 581,509 | 157,490 | -72.9% | 65 | 43 | -33.7% |
| carry-refusals | question | 87,455 | 138,064 | +57.9% | 28 | 30 | +4.0% |
| day-night-phases | question | 84,603 | 87,605 | +3.5% | 25 | 24 | -3.4% |
| latest-save-slot | question | 121,878 | 102,121 | -16.2% | 32 | 28 | -14.3% |
| undo-block-edits | question | 206,213 | 244,123 | +18.4% | 45 | 44 | -1.9% |

Median per-task change: input tokens +20.7% (95% interval -15.1% to +30.6%; lower on 3 of 10
tasks); cost (a weighted token count, since Strata charges nothing) +4.9% (-6.8% to +14.0%);
wall time -8.8% (-21.0% to +4.9%; lower on 7 of 10 tasks). Proxy and harness token totals
agree to 0.0% over 100 runs. Every comments-arm run read some comments, a median of 15.8 KB.

**What it shows.** No success difference (50/50 against 50/50), and no token difference
that five repetitions can separate from run-to-run noise: the interval includes both a
15% saving and a 31% cost. The effect varies by task more than it points one way: four of the
five fixes used more input tokens with comments and one fewer (-30.7%), and the questions
split two lower, three higher.

**What it does not show.** Success is at its ceiling, so a harder task set could still show
a success effect. Five fixes and five questions is a small set, and the questions are quick
to answer without comments (a median 25 to 65 seconds). One local, quantized model; Claude
Code only; no summaries arm.

### Where the change came from

Split by repository, a pattern the benchmark was not designed to test (four and five tasks)
shows in both harnesses: comments lowered input tokens on click and raised them on
cairn-comments.

| Harness | Repository | Tasks | Input tokens, median per-task change | Turns | Lower on |
| --- | --- | --- | --- | --- | --- |
| Claude Code | click | 4 | -23.9% | -21.2% | 3 of 4 |
| Claude Code | cairn-comments | 5 | +41.4% | +37.8% | 0 of 5 |
| pi | click | 4 | -6.4% | -9.2% | 3 of 4 |
| pi | cairn-comments | 5 | +19.5% | +12.5% | 2 of 5 |

In the comments arm the agents read a median of about 2,000 to 2,300 comment bytes on
cairn-comments against 700 to 900 on click. The cause is not established. cairn-comments is
the tool itself, and its tasks are about comment placement and sidecars, so its comments
describe the same machinery the agent is debugging; files rewritten by the post-edit hook are
not it (one "modified since read" error in 45 Claude Code comments-arm runs). With four and
five tasks per repository, this is a lead for the large-repository test, not a finding.

The report (`npm run benchmark -- report --work /c/cb`, as § Running it writes it):

### claude (qwen3.8-flash-next-iq2_xs)

Median (interquartile range) per run.

| Arm | Success | Input tokens, all | Uncached input | Cache read | Cache write | Output | Turns | Tool calls | Files read | Wall time (s) | Cost ($) | Comment bytes read |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| comments | 45/45 | 1,329,264 (645,644 to 2,776,689) | 50,769 (33,022 to 66,827) | 1,279,374 (522,709 to 2,720,149) | 0 (0 to 0) | 20,509 (11,430 to 31,666) | 35 (22 to 42) | 35 (23 to 44) | 5 (3 to 7) | 366 (146 to 634) | 1.617 (0.837 to 2.546) | 2,102 (889 to 2,437) |
| none | 45/45 | 1,275,223 (710,411 to 1,854,607) | 47,256 (31,158 to 59,867) | 1,229,520 (586,218 to 1,790,718) | 0 (0 to 0) | 21,936 (14,058 to 26,113) | 30 (20 to 36) | 31 (27 to 37) | 4 (3 to 6) | 297 (172 to 460) | 1.541 (0.876 to 1.938) | 0 (0 to 0) |

Per task, each arm's median and the comments arm's change against none:

| Task | Success, none | comments | Input tokens, all, none | comments | change | Cost ($), none | comments | change | Wall time (s), none | comments | change |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delete-last-comment-stages-sidecar | 5/5 | 5/5 | 1,941,270 | 2,318,710 | +19.4% | 1.873 | 1.984 | +5.9% | 666 | 595 | -10.7% |
| echo-ansi-stripping | 5/5 | 5/5 | 187,591 | 141,216 | -24.7% | 0.317 | 0.267 | -15.7% | 58 | 47 | -18.3% |
| path-dash-byteswarning | 5/5 | 5/5 | 883,939 | 679,365 | -23.1% | 1.473 | 1.608 | +9.2% | 277 | 234 | -15.4% |
| progressbar-final-position | 5/5 | 5/5 | 798,173 | 860,707 | +7.8% | 1.876 | 2.051 | +9.3% | 366 | 380 | +3.8% |
| rename-keeps-orphan-entries | 5/5 | 5/5 | 2,173,446 | 3,074,242 | +41.4% | 2.005 | 2.546 | +27.0% | 480 | 677 | +41.0% |
| sidecar-merge-placement | 5/5 | 5/5 | 152,096 | 176,155 | +15.8% | 0.334 | 0.358 | +7.0% | 66 | 71 | +7.1% |
| stale-tag-and-eof-trailing | 5/5 | 5/5 | 1,815,472 | 3,352,704 | +84.7% | 1.775 | 3.636 | +104.9% | 375 | 767 | +104.7% |
| style-color-validation | 5/5 | 5/5 | 1,399,913 | 956,919 | -31.6% | 1.375 | 0.930 | -32.3% | 216 | 152 | -29.5% |
| unparseable-harness-settings | 5/5 | 5/5 | 1,078,447 | 1,733,118 | +60.7% | 1.126 | 1.649 | +46.5% | 291 | 370 | +26.9% |

Median per-task change: input tokens, all +15.8% (95% interval -5.4% to +47.2%; lower on 3 of 9 tasks); cost ($) +9.2% (95% interval -10.5% to +47.6%; lower on 2 of 9 tasks); wall time (s) +3.8% (95% interval -17.2% to +38.5%; lower on 4 of 9 tasks).

Check: largest difference between proxy and harness token totals: 0.0% over 90 runs.

### pi (qwen3.8-flash-next-iq2_xs)

Median (interquartile range) per run.

| Arm | Success | Input tokens, all | Uncached input | Cache read | Cache write | Output | Turns | Tool calls | Files read | Wall time (s) | Comment bytes read |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| comments | 36/45 | 712,650 (397,457 to 1,001,420) | 41,516 (27,067 to 55,701) | 673,655 (368,669 to 959,904) | 0 (0 to 0) | 15,121 (10,047 to 20,210) | 28 (22 to 33) | 38 (30 to 42) | 3 (2 to 6) | 217 (121 to 337) | 899 (0 to 2,292) |
| none | 35/45 | 706,434 (391,486 to 1,162,852) | 39,739 (24,205 to 59,218) | 656,756 (368,082 to 1,105,353) | 0 (0 to 0) | 14,164 (9,208 to 21,373) | 27 (19 to 34) | 36 (28 to 42) | 4 (2 to 7) | 215 (118 to 343) | 0 (0 to 0) |

Per task, each arm's median and the comments arm's change against none:

| Task | Success, none | comments | Input tokens, all, none | comments | change | Wall time (s), none | comments | change |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delete-last-comment-stages-sidecar | 0/5 | 2/5 | 733,297 | 876,490 | +19.5% | 229 | 358 | +56.7% |
| echo-ansi-stripping | 4/5 | 5/5 | 224,848 | 200,441 | -10.9% | 80 | 77 | -4.3% |
| path-dash-byteswarning | 5/5 | 4/5 | 1,162,852 | 485,275 | -58.3% | 373 | 172 | -53.9% |
| progressbar-final-position | 4/5 | 5/5 | 416,805 | 650,249 | +56.0% | 133 | 170 | +28.3% |
| rename-keeps-orphan-entries | 4/5 | 2/5 | 1,538,903 | 1,319,250 | -14.3% | 425 | 325 | -23.7% |
| sidecar-merge-placement | 5/5 | 5/5 | 147,533 | 240,740 | +63.2% | 77 | 109 | +40.8% |
| stale-tag-and-eof-trailing | 3/5 | 3/5 | 788,597 | 1,083,536 | +37.4% | 242 | 355 | +46.9% |
| style-color-validation | 5/5 | 5/5 | 491,237 | 481,563 | -2.0% | 150 | 145 | -2.9% |
| unparseable-harness-settings | 5/5 | 5/5 | 1,228,752 | 953,264 | -22.4% | 397 | 324 | -18.3% |

Median per-task change: input tokens, all -2.0% (95% interval -18.5% to +35.8%; lower on 5 of 9 tasks); wall time (s) -2.9% (95% interval -16.7% to +40.8%; lower on 5 of 9 tasks).

Check: largest difference between proxy and harness token totals: 0.0% over 90 runs.
