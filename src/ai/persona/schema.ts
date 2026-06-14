import { z } from "zod";

// one few-shot exchange that demonstrates the persona's voice
const exampleSchema = z.object({
  user: z.string().min(1),
  assistant: z.string().min(1),
});

// skiff persona spec: prose + example dialogue, no numeric trait scoring.
// models pattern-match voice from concrete examples far better than from
// numbers like "extraversion 0.4", so the spec leans on description + examples.
export const personaSchema = z.object({
  name: z.string().min(1),
  nickname: z.string().optional(),
  // prose: who they are, role, background, what they're like to work with
  description: z.string().min(1),
  // how they talk, as short bullets the model can mirror
  voice: z.array(z.string().min(1)).min(1),
  // optional: persona-specific leanings (how this character actually works)
  principles: z.array(z.string().min(1)).optional(),
  // optional: phrases this persona never uses
  avoid: z.array(z.string().min(1)).optional(),
  // few-shot exchanges, the highest-leverage field
  examples: z.array(exampleSchema).min(1),
  // optional metadata, never rendered into the prompt
  meta: z
    .object({
      version: z.string().optional(),
      author: z.string().optional(),
    })
    .optional(),
});

export type Persona = z.infer<typeof personaSchema>;
export type PersonaExample = z.infer<typeof exampleSchema>;
