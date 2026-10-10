## 6vmn
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:49Z pos=before node=3ca6ae8c -->
65516 is 65520 minus the header, so a payload larger than this must be split into several packets;
git rejects a single oversized one.

## hntw
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:50Z pos=before scope=PacketReader decl=PacketReader.read node=911041a4 -->
The two are different answers and the protocol loop depends on them: a flush ends a list, while a
clean end of input means git closed the pipe.

## c2pv
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:51Z pos=before decl=contentPackets node=b3339732 -->
Zero packets is what a zero-byte file answers with, so a caller must not assume at least one.
