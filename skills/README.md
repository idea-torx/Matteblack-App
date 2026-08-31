# Built-in skills

The recipes Fal Forge ships with. They are seeded into `~/.matteblack/skills/`
on first run, where the Skills panel edits them like any other skill — your
edits there are never overwritten.

These files are the readable copy. The bundled server carries the same text as
constants in [`server/skills/builtin.ts`](../server/skills/builtin.ts); change
one and copy it onto the other, or `server/cuts/seed.test.ts` fails.

`library/` holds the skills written in the app rather than shipped with it —
backed up here so they survive a reinstall. Nothing reads them automatically;
drop one into the Skills panel with Import.
