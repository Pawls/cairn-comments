## v0ax
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:22Z pos=before decl=measure_table node=6cc0afbd -->
Column widths measured in visible chars (term_len), so ANSI-styled option
names don't inflate help columns.

## qn8r
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:23Z pos=before decl=iter_rows node=36f24229 -->
Pads short rows to col_count; call it with the col_count from measure_table so
column indices stay aligned.

## 3dve
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:24Z pos=before decl=HelpFormatter node=f50e6923 -->
Buffer-only: nothing reaches a stream until getvalue; core.py builds help text
with it and echoes the result.

## yb3q
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:25Z pos=before scope=HelpFormatter decl=HelpFormatter.__init__ node=fdf1077a -->
FORCED_WIDTH overrides the terminal width for tests (testing.py sets it);
width is fixed at construction, so a later terminal resize is not picked up.

## gbsm
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:26Z pos=before scope=HelpFormatter decl=HelpFormatter.write_dl node=16e46d9d -->
First column is capped at col_max; a term longer than the cap drops to its
own line instead of pushing the description right.

## 9buv
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:31Z pos=before decl=join_options node=b138b1f5 -->
Sorts by prefix length so short names come first ("-f, --foo"). core.py's
format_options uses the slash flag to join names with "; " instead of " /".
