You are leaving notes in this repository for the AI coding agents who will work in it after
you. Read the source code and add comments that would save a later agent time:

- what a function or module is for, when its name does not say so;
- contracts and invariants a caller must respect, and what breaks if they are ignored;
- why non-obvious code is written the way it is;
- where a behavior is decided, and how pieces in different files connect.

Write every note as a sigil comment on its own line, directly above the code it describes:
`#~ note` in Python, `//~ note` in TypeScript and JavaScript. Keep each note to one to three
lines, and only write what is true of the code as it is now.

Do not change any code, and do not edit or remove existing comments. Do not run tests,
builds, or installs. Cover the main source files; skip tests, fixtures, generated files,
and vendored code. When you are done, reply with the list of files you annotated.
