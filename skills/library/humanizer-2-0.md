# Humanizer 2.0

A practical editing pass for removing recognizable AI-writing habits without flattening a real person's voice.

Source: [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)

## Core rule

Do not try to make text look "less AI" by adding random slang, typos, or forced quirks. Make it more human by making it more specific, owned, varied, and accountable.

A single feature is not evidence. Judge clusters of patterns, the context, and whether the writer has a real reason for choosing the words.

## When to use

Use this pass for articles, LinkedIn posts, essays, product copy, emails, documentation, scripts, and drafts that feel generic, over-polished, or machine-assembled.

## Pass 1: remove inflated framing

Cut or rewrite:

- Claims that an ordinary fact is a "pivotal moment," "testament," "reflection," or "broader shift"
- Grand conclusions about society, the future, legacy, identity, or transformation that the evidence does not support
- Generic references to "ongoing discussions," "the evolving landscape," or "broader trends"
- Promotional adjectives such as groundbreaking, vibrant, rich, renowned, seamless, powerful, and revolutionary
- Vague authority: "experts say," "observers note," "industry reports show," or "critics argue"

Replace them with the fact, the source, the actor, and the consequence.

> Weak: The project represents a pivotal shift in the evolving AI landscape.
>
> Better: The project lets applicants review each browser action before it runs.

## Pass 2: make the verbs and subjects accountable

Prefer active, concrete sentences:

- Name who did the thing
- Use "is," "has," and "does" when they are the clearest verbs
- Replace subjectless fragments such as "No setup required" with a complete sentence when clarity matters
- Remove stacked present-participle phrases: highlighting, underscoring, reflecting, showcasing, fostering, ensuring, and contributing
- Avoid passive voice when hiding the actor would mislead the reader

## Pass 3: remove formulaic language

Look for:

- "Not only X, but also Y"
- "It's not just X; it's Y"
- "From X to Y" when the endpoints are not a meaningful range
- Forced groups of three
- Synonym cycling for the same subject
- "At its core," "the real question," "what really matters," and similar authority poses
- "Let's dive in," "here's what you need to know," and other announcements of the writing
- Questions immediately answered by the next sentence
- Reassurance tacked onto the end: "and that's okay," "you're not alone," "no shame in"

State the point directly. Keep a list only when the list itself helps the reader.

## Pass 4: fix formatting tells

- Use sentence case for headings unless the publication's style requires otherwise
- Do not add a heading that merely repeats the title
- Avoid bold-label vertical lists such as `**Speed:** ...` unless the labels genuinely improve scanning
- Remove decorative emoji from headings and bullets
- Use em dashes sparingly; replace most with a period, comma, colon, or parentheses
- Avoid perfectly symmetrical paragraphs and identical sentence rhythms
- Do not manufacture typos, lowercase, slang, or messy punctuation to simulate a person

Formatting should follow the medium. A LinkedIn post can be loose. A technical document can be structured. Neither should look mechanically decorated.

## Pass 5: restore a real point of view

Add only what is supported by the writer's actual position:

- A specific observation
- A first-person experience, if the writer has one
- A limitation or uncertainty that matters
- A concrete disagreement or trade-off
- One detail that could not have been written about every similar product or project
- A practical consequence for the reader

Do not invent anecdotes, named people, studies, metrics, quotes, customers, or feelings. If a claim needs evidence, mark it for verification instead of smoothing it over.

## Pass 6: citation and factual-integrity check

Wikipedia's page also flags fabricated or malformed references. Before publication:

1. Open every important source.
2. Confirm that the source says what the draft claims.
3. Check names, dates, links, DOIs, quotes, and statistics.
4. Remove citations that do not support the nearby sentence.
5. Never use a plausible-looking citation as decoration.
6. Separate what was observed from what was inferred.

A clean prose pass cannot rescue false evidence.

## Pass 7: audience and medium check

Rewrite for the actual reader, not for a generic internet audience.

- Say what the reader can do, decide, understand, or avoid.
- Replace abstract benefits with a visible outcome.
- Cut the introduction if the useful sentence starts later.
- Keep the strongest claim proportional to the proof.
- Do not turn a personal post into a press release.
- Do not turn documentation into motivational copy.
- Do not turn an opinion into a fake neutral consensus.

## LinkedIn pass

For a LinkedIn article or post:

- Lead with the human consequence or useful idea, not the project name.
- Keep one clear thesis.
- Use concrete ownership: "I built," "I tested," "I changed," or "I learned."
- Avoid engagement bait, generic inspiration, and polished mic-drop closers.
- End with a result, caveat, or practical next step.
- Keep external links purposeful and verify them.
- Preserve the writer's ordinary voice when read aloud.

## Final audit

Ask:

1. Could this sentence describe ten other companies or projects?
2. Who is doing the action?
3. Is this claim supported, or merely confident?
4. Did the draft add significance that the evidence does not earn?
5. Are the headings and lists helping, or decorating?
6. Did I add a phrase because it is true, or because it sounds professional?
7. Does the rhythm sound like a person thinking, or a template completing itself?
8. Is there any invented detail?
9. Can I cut 10 percent without losing meaning?
10. Does the final version still sound like its author?

## Output protocol

When editing:

1. Preserve the meaning and factual claims unless they fail verification.
2. Identify the main AI-pattern clusters briefly.
3. Produce the revised text.
4. Run the final audit once more.
5. Show remaining uncertainty instead of hiding it.

The goal is not to beat an AI detector. The goal is writing that is precise, attributable, useful, and recognizably owned by a person.

## Important caveat

The source page describes tendencies, not a reliable authorship test. Human writers use em dashes, headings, passive voice, lists, and polished language. Do not accuse a writer or reject text from one stylistic signal alone.

---

## Leo voice overlay

Use this after the humanization pass. It is a voice guide, not a costume.

### Core sound

- Write like a builder explaining what actually happened, not a brand announcing a launch.
- Use first person naturally: “I realized…”, “I tried…”, “Yesterday I…”
- Be technically specific, then let the implication do the selling.
- Keep a little roughness: contractions, short asides, “honestly,” “lol,” or “haha” only when they sound natural.
- Be enthusiastic when the result earns it. Do not manufacture excitement.
- Prefer a sharp observation over a motivational conclusion.
- Sound curious, practical, and slightly irreverent. Never smug.
- Use short paragraphs and varied sentence lengths. Avoid content-calendar symmetry.

### Leo preferences

- Build in public: show the starting point, the useful change, and the realization behind it.
- Favor leverage, reuse, and “the thing was already there” over grand reinvention.
- Make the human decision visible: what was cut, simplified, verified, or left for later.
- Name real tools and artifacts when they matter: CLI, CMS, notes, payments, invoices, MCP, GitHub, or a live product link.
- Keep promotion grounded in a concrete capability or observed result.
- Make hot takes pointy but approachable. Critique a habit or assumption, not a person.
- Use emojis and hashtags sparingly, only when they add tone or discoverability.

### Banned by default

Avoid: “game-changer,” “revolutionary,” “seamless,” “unlock,” “excited to announce,” “in today’s fast-paced world,” “the future is here,” “not just X but Y,” “it’s worth noting,” and generic calls to action.

Also avoid forced vulnerability, fake behind-the-scenes drama, excessive em dashes, symmetrical three-part slogans, and tidy “lesson learned” endings.

### Editing recipe

1. State what happened in plain language.
2. Add one concrete detail that proves it.
3. Include the personal realization or trade-off.
4. Cut what the reader can infer.
5. Read it aloud. Keep the sentence that sounds most like Leo and delete the one that sounds most like a content calendar.

### Final Leo check

- Would Leo actually say this to another builder?
- Is there a real artifact, decision, result, or observation underneath it?
- Does the enthusiasm come from the work rather than adjectives?
- Is the sharpest line specific enough to remember?
- Does it end naturally instead of asking for engagement?
