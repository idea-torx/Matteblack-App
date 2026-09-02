---
name: Layout — tidying the canvas
description: How to organise, group, align or line up what's already on the canvas. Covers the see → plan → arrange → confirm loop, the 24px gutter grid, where variants and frames go, and what must never be moved.
---

# Layout — tidying the canvas

Use this whenever the ask is about the canvas as a *space* rather than about making something new:
"tidy this up", "organise the canvas", "group these", "line them up", "clean up the mess",
"put the variants together". You have two tools for it and they are always used as a pair.

## The loop

1. **see_canvas** — always first. It gives you every node's real id, type, label, position, size and
   locked flag. Never invent an id and never work from what you remember laying out last turn; the
   user has been moving things by hand since.
2. **Plan on paper.** Work out the whole layout before you touch anything — every final x/y in canvas
   world units, top-left origin, y growing downward.
3. **arrange_canvas, once.** Send the entire plan as one `moves` array. One call per node makes the
   bot's cursor stutter across the canvas for a minute and gives the user no single undo.
4. **see_canvas again** to confirm it landed, then report in one line. Do not re-arrange because the
   numbers came back slightly different from your plan — they won't.

## The grid

- **24px gutters**, everywhere, between everything. It is the only spacing number in this skill.
- **Rows, left to right, in creation order.** The order see_canvas returns *is* creation order —
  keep it. Re-sorting by size or type destroys the user's mental map of their own canvas.
- Break to a new row when the row gets wider than roughly the viewport width see_canvas reports.
  Row height is the tallest node in that row; the next row starts 24px below it.
- **Variants sit to the right of their source**, on the same row, as a run. A variant is a node that
  came out of an edit/upscale/remix of another — same subject, adjacent in creation order. Keeping
  the run horizontal is what makes a lineage readable at a glance.
- **Frames go on the left**, in their own column, ahead of the loose nodes. They are containers; the
  eye should hit them first.

## Never

- **Never move a locked node.** The route skips them and tells you so, but planning around them is
  your job: treat a locked node's rectangle as occupied ground and lay the rest out around it.
- **Never move what the user just selected.** If they attached or selected nodes this turn, those are
  the thing they are working on — leave them exactly where they are and tidy around them.
- **Never resize** unless resizing was asked for. Tidying means position. Sizes carry the user's own
  judgement about what matters on this canvas, and normalising them quietly throws that away.
- Never tidy unprompted after a generation. New work lands where the placement logic put it; that is
  not a mess, and rearranging the canvas the user didn't ask you to touch is startling.

## Reporting

One line: what you did and anything skipped — *"Laid out 14 nodes in 4 rows, 24px gutters; left the
two locked frames where they were."* The user is watching the cursor walk; they don't need a
description of a layout they just saw happen.
