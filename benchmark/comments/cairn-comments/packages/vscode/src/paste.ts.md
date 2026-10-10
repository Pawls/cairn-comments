## v89x
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:13:15Z pos=before decl=wholeRows node=46ff13e6 -->
A copy that starts mid-line or stops before its line's end cannot paste on its own lines, so it answers
undefined and the paste goes inline at the cursor instead.

## yd5l
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:13:18Z pos=before scope=CommentPaste decl=CommentPaste.prepareDocumentPaste node=ef371c6d indent=0 -->
The data transfer is the only thing that survives from a copy to its paste, so every fact the paste needs — the
whole rows, the ids, the repository — has to be recorded in the payload here.

## 6id3
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:13:22Z pos=before scope=CommentPaste decl=CommentPaste.provideDocumentPasteEdits node=b9be09c2 indent=0 -->
The clipboard is compared with the payload because it may have been replaced after the copy: a mismatch means
this paste is not the extension's copy, and answering undefined lets the ordinary paste run.

## aqnk
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:13:26Z pos=before scope=CommentPaste decl=CommentPaste.source node=ca148c8e indent=0 -->
Only a file that shows its comments through the overlay has sites to test, so a source that shows them inline
answers undefined and its comments are copied rather than moved.
