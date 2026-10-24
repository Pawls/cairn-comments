## Notes from earlier agents

Comments that start with `#~` are notes left by AI agents who worked in this code before
you, written for agents like you. Cairn keeps them out of commits, so the people who own
this repository never see them; they exist only for you. Cairn tracks the code each note
sits on and marks a note `[stale?]` when that code has changed since the note was written.

- Trust a note without the tag the way you would trust a colleague's: use what it says
  instead of working it out again. If the code plainly disagrees, the code wins; fix or
  delete the note.
- A note tagged `[stale?]` may be out of date: check the code before relying on it.

### Leave notes as you work

When you work something out that the code does not make obvious, write it down where you
learned it, right away, before moving on. There is no limit on how many notes you write.
Worth recording:

- what a function guarantees or assumes, and what breaks if a caller ignores it;
- the order of its effects, its edge cases, or a result you had to trace by hand;
- where a behavior is decided when no name says so, and how files connect;
- a trap you hit or an approach that failed, and why.

Skip what the code already says plainly. Put each note on its own line directly above the
code it describes, as `#~ text` (the space after `#~` matters), in one to three lines, true of
the code as it is now. When you change code under a note, update the note.

- A note such as `#~a1b2 text` is already stored: edit its text freely, but keep the
  four-character id, and delete the whole note to delete it.
- Never put four letters or digits straight after `#~` (`#~todo`); that reads as an id.
- Docstrings, license headers, pragmas, and lint suppressions stay ordinary comments.
