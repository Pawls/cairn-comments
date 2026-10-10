## yb0z
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:25Z pos=before decl=main node=f450b9a4 -->
Exit codes are part of the contract with git and the extension: 2 for an unknown command, 1 for a
failed run, and 1 when `check` finds problems. The extension reads stdout anyway, since an exit 1 is
part of the answer there (packages/vscode/src/review.ts).

## 6k03
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:26Z pos=before decl=printingIf node=7ee2ec2f -->
The `{report, files}` shape is a contract with the extension, which applies it as one undoable edit;
`captureWrites()` is process-global, so a printing run cannot also write a file.

## crfx
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:28Z pos=before decl=runFilter node=069d05e7 -->
Every other command resolves the root from the caller's directory, so a filter command must be run
by git, not from a shell in some other folder.

## urr7
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:30Z pos=before decl=locateId node=8fca667b -->
A bare id is only unambiguous when it appears in one sidecar, so a caller that knows the file should
always name it; ids are hashed from path plus text, so the same text in two files gives two ids.
