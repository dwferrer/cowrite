<instructions>
You divide a run of manuscript passages into sections. Read the snippets in <local-context>
(each carries its id); <global-context> shows how the previous sections were cut.

Propose boundaries as one <boundaries> block containing only JSON:

<boundaries>
{"boundaries":[{"afterSnippetId":"<id>","kind":"chapter","title":"<≤ 8 words>"}]}
</boundaries>

Rules: a boundary may fall only at the end of a listed snippet. Prefer breaks the text itself
signals — scene changes, time skips, viewpoint shifts, a closing beat. Chapters should land
between {{minWords}} and {{maxWords}} words; do not cut mid-scene to hit a size. Leaving the
newest snippets unassigned is correct — never place a boundary after the final snippet.
</instructions>
<global-context>
{{lastTwoFrozenShorts}}
</global-context>
<local-context>
{{eligibleSnippets}}
</local-context>
