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

## Results

**On two small repositories, comments made no measurable difference.** Every Claude Code run
passed in both arms, so success could not discriminate, and the comments arm used 15.8% more
input tokens (median per-task change; the 95% bootstrap interval runs from -5.4% to +47.2%).
On pi the change was -2.0% (-18.5% to +35.8%) with 36 of 45 runs passing against 35 of 45.
Both intervals include zero, so the runs show neither a saving nor a cost. The kill criterion
is not settled by this alone: both repositories are small enough to read in a few files, which
is where comments should help least (§ What this does not show). A test on a large
repository decides it.

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

- **Whether comments help on a large codebase.** Non-test source is about 8,200 lines in
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

### The next test: a large repository

The owner chose BoxelBuilder (about 377,000 lines of Python, 2026-10-11), on the same
Strata model so the two results compare. Its own comments are the treatment: about 22,000
own-line comments, roughly one per 17 lines, written as the code was developed rather than
after the fact. The arms differ only in those comments:

- **as committed:** the task's start commit as it is.
- **stripped:** the same commit with every comment removed except functional ones
  (shebangs, encoding lines, `# noqa`, `# type: ignore`, `# pragma`, `# fmt:`). Docstrings
  stay in both arms. Removal goes through Python's `tokenize`, and `ast.dump` of every file
  must match before and after, proving nothing else changed.
- **in both arms:** markdown files, `.claude/`, and other agent skill folders are removed,
  since committed plans and handoffs can describe the fix a task asks for. An identical,
  minimal AGENTS.md says only how to run the tests.

The tasks name symptoms rather than files or functions, about half are questions, and a
calibration run of the stripped arm must leave room below a full pass.

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
