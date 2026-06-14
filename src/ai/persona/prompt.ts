import { logger } from "../../config/logger.js";
import type { Persona } from "./schema.js";

const bullets = (items: string[]): string[] => items.map((i) => `- ${i}`);

// render a persona into a natural-language system prompt block: prose + a
// few-shot examples section. no numeric trait dumps, no dead physical fields.
export const buildPersonaPrompt = (persona: Persona): string => {
  const displayName =
    persona.nickname && persona.nickname !== persona.name
      ? `${persona.name} (${persona.nickname})`
      : persona.name;

  const parts: string[] = [`You are ${displayName}.`, "", persona.description];

  parts.push("\n## Voice", ...bullets(persona.voice));

  if (persona.principles && persona.principles.length > 0) {
    parts.push("\n## How you work", ...bullets(persona.principles));
  }

  if (persona.avoid && persona.avoid.length > 0) {
    parts.push(
      "\n## Never say",
      "These phrasings aren't you, don't use them:",
      ...persona.avoid.map((p) => `- "${p}"`)
    );
  }

  // examples are the highest-leverage part: the model mirrors tone and length
  // from them. they're illustrations, not literal turns (real turns carry a
  // sender block), so render them plainly.
  parts.push(
    "\n## Examples of your voice",
    "Match this tone and length. These are illustrations, not a script."
  );
  persona.examples.forEach((ex) => {
    parts.push(`\nUser: ${ex.user}`, `You: ${ex.assistant}`);
  });

  const prompt = parts.join("\n");
  logger.debug("persona prompt built", {
    name: persona.name,
    voiceCount: persona.voice.length,
    exampleCount: persona.examples.length,
    length: prompt.length,
  });
  return prompt;
};
