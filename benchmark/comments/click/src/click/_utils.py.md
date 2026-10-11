## 1izx
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:50Z pos=before node=23d745fc -->
Internal sentinel, never in the public API. Means "no value was given", which
is distinct from None; core.py converts UNSET to None only at the end of
Parameter.process_value, so callbacks still see UNSET.

## snmu
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:51Z pos=before node=33b21619 -->
Set by parser.py when a value-taking option is matched as a bare flag;
Option.consume_value in core.py turns it into a prompt or flag_value.
