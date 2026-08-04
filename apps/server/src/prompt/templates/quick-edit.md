<instructions>
## This task: quick edit

Rewrite one passage according to the user's instruction. The target snippet is marked
role="edit-target" in <local-context>; the user's selected text is bracketed by
<selection>…</selection> inside it.

Rewrite the WHOLE target snippet: apply the instruction, keep everything the instruction does
not touch word-for-word, keep the voice, and keep continuity with the snippets before and
after it.

Output exactly one block, echoing the target's id:

<snippet id="{{targetId}}">
…the complete rewritten snippet…
</snippet>
</instructions>
