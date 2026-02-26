import { z } from "zod";

// sub-schemas

const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  uri: z.string(),
  version: z.string(),
  auto_activate: z.boolean(),
  priority: z.number().int().min(1).max(10),
});

const placeSchema = z.object({
  city: z.string(),
  country: z.string(),
});

const skinSchema = z.object({
  tone: z.string(),
  texture: z.string(),
  details: z.array(z.string()),
});

const eyesSchema = z.object({
  color: z.string(),
  shape: z.string(),
  eyebrows: z.string(),
  corrective_lenses: z.string(),
});

const hairSchema = z.object({
  color: z.string(),
  style: z.string(),
  texture: z.string(),
});

const faceSchema = z.object({
  shape: z.string(),
  skin: skinSchema,
  eyes: eyesSchema,
  hair: hairSchema,
  facial_hair: z.string(),
  nose: z.string(),
  mouth: z.string(),
  distinguishing_features: z.array(z.string()),
});

const bodySchema = z.object({
  height_cm: z.number(),
  weight_kg: z.number(),
  somatotype: z.enum(["Ectomorph", "Mesomorph", "Endomorph", ""]),
  build_description: z.string(),
  posture: z.string(),
  scars_tattoos: z.array(z.string()),
});

const styleSchema = z.object({
  aesthetic_archetype: z.string(),
  clothing_preferences: z.array(z.string()),
  accessories: z.array(z.string()),
  color_palette: z.array(z.string()),
});

const imagePromptsSchema = z.object({
  portrait: z.string(),
  full_body: z.string(),
});

const neuralMatrixSchema = z.object({
  creativity: z.number().min(0).max(1),
  empathy: z.number().min(0).max(1),
  logic: z.number().min(0).max(1),
  adaptability: z.number().min(0).max(1),
  charisma: z.number().min(0).max(1),
  reliability: z.number().min(0).max(1),
});

const oceanSchema = z.object({
  openness: z.number().min(0).max(1),
  conscientiousness: z.number().min(0).max(1),
  extraversion: z.number().min(0).max(1),
  agreeableness: z.number().min(0).max(1),
  neuroticism: z.number().min(0).max(1),
});

const triggersSchema = z.object({
  joy: z.array(z.string()),
  anger: z.array(z.string()),
  sadness: z.array(z.string()),
});

const ttsConfigSchema = z.object({
  provider: z.string(),
  voice_id: z.string(),
  stability: z.number().min(0).max(1),
  similarity_boost: z.number().min(0).max(1),
});

const acousticsSchema = z.object({
  pitch: z.string(),
  speed: z.string(),
  roughness: z.number().min(0).max(1),
  breathiness: z.number().min(0).max(1),
});

const keyLifeEventSchema = z.object({
  year: z.number().int(),
  event: z.string(),
  impact: z.string(),
});

// top-level section schemas

const metadataSchema = z.object({
  instance_id: z.string(),
  instance_version: z.string(),
  generator: z.string(),
  created_at: z.string(),
  last_updated: z.string(),
});

const capabilitiesSchema = z.object({
  skills: z.array(skillSchema),
});

const identitySchema = z.object({
  names: z.object({
    first: z.string(),
    middle: z.string(),
    last: z.string(),
    nickname: z.string(),
  }),
  bio: z.object({
    birthday: z.string(),
    age_biological: z.number().int(),
    age_perceived: z.number().int(),
    gender: z.string(),
  }),
  origin: z.object({
    nationality: z.string(),
    ethnicity: z.string(),
    birthplace: placeSchema,
  }),
  residence: z.object({
    current_city: z.string(),
    current_country: z.string(),
    dwelling_type: z.string(),
  }),
});

const physicalitySchema = z.object({
  face: faceSchema,
  body: bodySchema,
  style: styleSchema,
  image_prompts: imagePromptsSchema,
});

const psychologySchema = z.object({
  neural_matrix: neuralMatrixSchema,
  traits: z.object({
    ocean: oceanSchema,
    mbti: z.string(),
    enneagram: z.string(),
    temperament: z.string(),
  }),
  moral_compass: z.object({
    alignment: z.string(),
    core_values: z.array(z.string()),
    conflict_resolution_style: z.string(),
  }),
  mental_patterns: z.object({
    decision_making_style: z.string(),
    attention_span: z.string(),
    learning_style: z.string(),
  }),
  emotional_profile: z.object({
    base_mood: z.string(),
    volatility: z.number().min(0).max(1),
    resilience: z.string(),
    triggers: triggersSchema,
  }),
  idiosyncrasies: z.object({
    phobias: z.array(z.string()),
    obsessions: z.array(z.string()),
    tics: z.array(z.string()),
  }),
});

const linguisticsSchema = z.object({
  voice: z.object({
    tts_config: ttsConfigSchema,
    acoustics: acousticsSchema,
    accent: z.object({
      region: z.string(),
      strength: z.number().min(0).max(1),
    }),
  }),
  text_style: z.object({
    formality_level: z.number().min(0).max(1),
    verbosity_level: z.number().min(0).max(1),
    vocabulary_level: z.string(),
    slang_usage: z.boolean(),
    style_descriptors: z.array(z.string()),
  }),
  syntax: z.object({
    sentence_structure: z.string(),
    use_contractions: z.boolean(),
    active_passive_ratio: z.number().min(0).max(1),
  }),
  interaction: z.object({
    turn_taking: z.string(),
    dominance_score: z.number().min(0).max(1),
    emotional_coloring: z.string(),
  }),
  idiolect: z.object({
    catchphrases: z.array(z.string()),
    forbidden_words: z.array(z.string()),
    hesitation_markers: z.boolean(),
  }),
});

const historySchema = z.object({
  origin_story: z.string(),
  education: z.object({
    level: z.string(),
    field: z.string(),
    institution: z.string(),
    graduation_year: z.number().int(),
  }),
  occupation: z.object({
    title: z.string(),
    industry: z.string(),
    years_experience: z.number().int(),
    previous_jobs: z.array(z.string()),
  }),
  family: z.object({
    relationship_status: z.string(),
    parents: z.string(),
    siblings: z.string(),
    children: z.string(),
    pets: z.string(),
  }),
  key_life_events: z.array(keyLifeEventSchema),
});

const interestsSchema = z.object({
  hobbies: z.array(z.string()),
  favorites: z.object({
    music_genre: z.string(),
    book: z.string(),
    movie: z.string(),
    color: z.string(),
    food: z.string(),
    season: z.string(),
  }),
  aversions: z.array(z.string()),
  lifestyle: z.object({
    diet: z.string(),
    sleep_schedule: z.string(),
    digital_habits: z.string(),
  }),
});

const motivationsSchema = z.object({
  core_drive: z.string(),
  goals: z.object({
    short_term: z.array(z.string()),
    long_term: z.array(z.string()),
  }),
  fears: z.object({
    rational: z.array(z.string()),
    irrational: z.array(z.string()),
  }),
});

// root AIEOS schema

export const aieosSchema = z.object({
  standard: z.object({
    // Intentionally strict
    protocol: z.literal("AIEOS"),
    version: z.literal("1.1.0"),
    schema_url: z.literal("https://aieos.org/schema/v1.1/aieos.schema.json"),
  }),
  metadata: metadataSchema,
  capabilities: capabilitiesSchema,
  identity: identitySchema,
  physicality: physicalitySchema,
  psychology: psychologySchema,
  linguistics: linguisticsSchema,
  history: historySchema,
  interests: interestsSchema,
  motivations: motivationsSchema,
});

export type AIEOS = z.infer<typeof aieosSchema>;
