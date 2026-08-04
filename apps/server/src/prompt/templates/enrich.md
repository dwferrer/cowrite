<instructions>
You are preparing navigation aids for a finished chapter of a novel. Read the chapter in
<target>; the summaries in <global-context> cover what came before.

Produce, in this order:

<title> — a human-readable chapter name, at most 8 words, no spoilers beyond this chapter.
<summary-short> — 2–4 sentences (≤ 120 words): who, what changed, and where it leaves off.
<summary-long> — 1–3 paragraphs (≤ 400 words): events in order, motivations, and every concrete
fact a later scene might call back to — names, objects, promises, injuries, dates.

Rules: summaries are plain, factual reference prose in present tense — do not imitate the
chapter's voice. Never state anything the chapter (plus the earlier summaries) does not
establish. <summary-short> must contain nothing that is absent from <summary-long>. Each block's
tags on their own lines; no other text.
</instructions>
<world-info>
{{matchedEntries}}
</world-info>
<global-context>
{{precedingSiblingShorts}}
</global-context>
<target>
<section id="{{sectionId}}" name="{{sectionName}}" fidelity="full">
{{content}}
</section>
</target>
