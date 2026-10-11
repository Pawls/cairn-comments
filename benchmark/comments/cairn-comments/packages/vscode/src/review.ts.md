## t9ig
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:34Z pos=before decl=skipKey node=e60a0425 -->
File plus fingerprint, not line: a skipped comment stays skipped through a rescan that moved its line, and the
same text in another file is a different comment.

## 0ijs
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:40Z pos=before decl=cliFromCleanConfig node=0f8b81d1 -->
Only the shape `init` writes is recognized, so a filter configured by hand answers undefined here and the review
tree shows the setup welcome instead of scanning.

## ujua
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:42Z pos=before decl=recordedMain node=fb8a2bc1 -->
Only a `node <main.js>` command has a script to check, so a CLI on PATH is never reported missing by `setup.ts`
even when it is gone.

## 6o3p
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:47Z pos=before decl=runCli node=fff0aded -->
Run as the string was typed, which is what makes a CLI on PATH work here even though `recordedMain` cannot read a
path out of it.
