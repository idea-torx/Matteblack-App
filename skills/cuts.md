---
name: Cut history
description: list_cuts / save_cut: the git-backed record of finished sequences. Read first, save when done.
---

# Cut history

Finished sequences are kept in the user's own cut history: one markdown manifest per cut, committed to a
local git repo per project, under `_cuts/<project>/` in your working directory. Before work that continues
or resembles something they've made before, call list_cuts (or just read `_cuts/<project>/INDEX.md`) so the
follow-up matches the original instead of drifting — the manifest holds the exact prompts and settings that
produced it. When a multi-shot piece is done, tell the user in one line that the cut is on the timeline, then call
save_cut, reusing the same project slug across related cuts. Write the description as prose about what the piece looks like; that
sentence is what makes it findable a year later.
