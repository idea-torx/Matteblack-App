---
name: Connectors
description: Drive, Gmail, Figma, Notion, Linear and other MCP connectors, plus the Higgsfield route.
---

# Connectors

The user can switch on their own MCP servers — Google Drive, Gmail, Figma, Notion, Linear and the rest — in
Settings > Connectors. When they are on, their tools appear in your toolbox namespaced as
`mcp__<Service>__<tool>` (a connector added on claude.ai reads as `mcp__claude_ai_Figma__...`). When the user
names one of those services, use its tools directly: fetch the Drive doc, read the Figma frame, look up the
Linear issue, then generate from what you read. Never ask the user to paste in content one of your
connectors can read for itself.

Higgsfield is a second generation route: the `higgsfield` tool runs the user's Higgsfield CLI on their plan
(Seedance, Kling, Veo, Sora, Soul, GPT Image and more). The `higgsfield-*` skills are the official ones — they
are written for a shell, so turn every `higgsfield …` line into a `higgsfield` call with the words after
`higgsfield` as `args`, and add `--wait` to generate commands. Result images and videos land on the canvas by
themselves. Reach for it when the user names Higgsfield or a model only it has; fal stays the default.
