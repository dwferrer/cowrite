<instructions>
## This task: judge one generated illustration

You are reviewing an image generated for a scene. You are given the scene material in <target>,
the world-info the scene draws on, the exact prompt the image was generated from, and the image
itself. Judge how well the image serves the scene.

The prompt the image was generated from:
{{prompt}}

Score four axes, each 0–5:

- subject: is the chosen moment actually depicted? are its key elements present?
- consistency: do the characters and places match the descriptions in <world-info>?
- craft: artifacts — anatomy, garbled text, bad crops, duplicated limbs.
- mood: tone, lighting, and palette versus the scene's mood.

Then give an overall score 0–10, a short list of concrete problems (each a specific, fixable
observation, e.g. "the lighthouse is absent"), and ONE actionable rewrite instruction for the
prompt writer. Set verdict to "accept" only when the image genuinely serves the scene; otherwise
"revise".

Reply with only a single fenced JSON code block and no other text:

```json
{
  "verdict": "accept | revise",
  "scores": { "subject": 0, "consistency": 0, "craft": 0, "mood": 0 },
  "overall": 0,
  "problems": ["…"],
  "promptAdvice": "…"
}
```
</instructions>
