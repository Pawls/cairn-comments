## xm35
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:44Z pos=before decl=EchoingStdin node=af48648d -->
When echo_stdin=True, reads from stdin are mirrored to stdout; _pause_echo
suppresses the echo during prompts so typed input isn't duplicated.

## y0p5
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:45Z pos=before decl=CliRunner node=52e5e162 -->
Mutates global interpreter state (sys streams, os.environ, termui hooks), so it
is single-threaded only.

## by0b
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:47Z pos=before scope=CliRunner decl=CliRunner.isolation node=02daa99b -->
FORCED_WIDTH=80 makes help output deterministic; the termui/should_strip_ansi
monkeypatches below pair with termui.py's module-level indirection so prompts
can be simulated from the captured input stream.

## 0rjp
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:48Z pos=before scope=CliRunner.isolation body=479767da stmts=1b84.9115.7706.6fb5.6bb3.7d48.3663.7708.aed5.af65.bb98.fcb5.a18f.2bd7.754e.3295.479a.9dbc.6022.39c7.edc7.752c.f623.e62b.dad5.a637.8f1b.8dae.06a2.fbc7.8764.c5c2.fe38.2a11.da5e in=26 node=8f1be1b1 -->
Assigning these names (not calling them) is what makes termui.prompt()
read from the test input stream; they're restored on exit.
