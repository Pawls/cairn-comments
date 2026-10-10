## yq9d
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:47Z pos=before decl=sidecarPathFor node=a498b5ba -->
Callers must pass a repo-relative path, never an absolute one: the result is compared against
git's output everywhere (check.ts, files.ts), and git always reports forward slashes.

## fjzp
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:48Z pos=before node=d3c3f0f4 -->
These two must stay exact inverses: exactly one backslash on write, exactly one removed on read, so
a body line that legitimately begins with a backslash round-trips.

## e96k
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:50Z pos=before decl=parseSidecar node=ebfa6eb6 -->
Reads LF text; the tool always writes sidecars as LF and `init` marks the sidecar folder
`text eol=lf` so autocrlf has nothing to convert. A metadata line only counts as the entry's own
when it is the first line after its heading.

## o50z
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:51Z pos=before decl=serializeSidecar node=03402de5 -->
Writes LF only, and entry order is the file order, which is what keeps a sidecar's diff small
across merges; an emptied sidecar is written as an empty string and the CLI deletes the file.
