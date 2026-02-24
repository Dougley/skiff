import { logger } from "../logger/index.js";
import type { AIEOS } from "./index.js";

const clamp = (value: number | undefined, fallback: number): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
};

const nonEmpty = (value: string | undefined | null): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const listToString = (
  values: string[] | undefined | null
): string | undefined => {
  if (!values || values.length === 0) {
    return undefined;
  }
  const filtered = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return filtered.length > 0 ? filtered.join(", ") : undefined;
};

const line = (label: string, value: string): string => `${label}: ${value}`;

const pushLine = (lines: string[], label: string, value?: string) => {
  if (!value) {
    return;
  }
  lines.push(line(label, value));
};

const pushList = (lines: string[], label: string, values?: string[] | null) => {
  const list = listToString(values);
  if (!list) {
    return;
  }
  lines.push(line(label, list));
};

const pushNumber = (
  lines: string[],
  label: string,
  value?: number | null,
  digits?: number,
  allowZero = false
) => {
  if (value === undefined || value === null) {
    return;
  }
  if (!allowZero && value === 0) {
    return;
  }
  const formatted =
    digits === undefined ? String(value) : value.toFixed(digits);
  lines.push(line(label, formatted));
};

const pushBoolean = (
  lines: string[],
  label: string,
  value?: boolean | null
) => {
  if (value === undefined || value === null) {
    return;
  }
  lines.push(line(label, String(value)));
};

const pushComposite = (
  lines: string[],
  label: string,
  parts: Array<string | undefined>
) => {
  const filtered = parts.filter((part) => Boolean(part)) as string[];
  if (filtered.length === 0) {
    return;
  }
  lines.push(line(label, filtered.join("; ")));
};

const appendSection = (
  persona: string[],
  title: string,
  lines: string[],
  includedSections?: string[]
) => {
  if (lines.length === 0) {
    return;
  }
  if (includedSections) {
    includedSections.push(title);
  }
  persona.push(`\n=== ${title} ===`, ...lines);
};

export const buildSystemPrompt = (aieos: AIEOS): string => {
  const { capabilities } = aieos;
  const identity = aieos.identity;
  const physicality = aieos.physicality;
  const psychology = aieos.psychology;
  const linguistics = aieos.linguistics;
  const history = aieos.history;
  const interests = aieos.interests;
  const motivations = aieos.motivations;

  const nameParts = [
    nonEmpty(identity.names.first),
    nonEmpty(identity.names.middle),
    nonEmpty(identity.names.last),
  ].filter(Boolean);
  const nickname = nonEmpty(identity.names.nickname);
  const name = nameParts.join(" ").trim();
  const displayName = nickname ? `${name} (${nickname})` : name;

  const textStyle = linguistics.text_style;
  const formality = clamp(textStyle.formality_level, 0.5);
  const verbosity = clamp(textStyle.verbosity_level, 0.5);
  const styleDescriptors = textStyle.style_descriptors
    .map((descriptor) => descriptor.trim())
    .filter((descriptor) => descriptor.length > 0)
    .slice(0, 6)
    .join(", ");

  const persona: string[] = [];
  const includedSections: string[] = [];

  persona.push(displayName ? `You are ${displayName}.` : "You are Skiff.");

  const capabilityLines: string[] = [];
  capabilities.skills.forEach((skill, index) => {
    const skillLines: string[] = [];
    const skillName = nonEmpty(skill.name);
    pushLine(skillLines, "Name", skillName ?? `Skill ${index + 1}`);
    pushLine(skillLines, "Description", nonEmpty(skill.description));
    pushLine(skillLines, "URI", nonEmpty(skill.uri));
    pushLine(skillLines, "Version", nonEmpty(skill.version));
    pushBoolean(skillLines, "Auto Activate", skill.auto_activate);
    pushNumber(skillLines, "Priority", skill.priority, undefined, true);
    if (skillLines.length > 0) {
      capabilityLines.push(`Skill ${index + 1}`);
      capabilityLines.push(...skillLines.map((entry) => `  ${entry}`));
    }
  });
  appendSection(persona, "Capabilities", capabilityLines, includedSections);

  const identityLines: string[] = [];
  pushLine(identityLines, "Name", nonEmpty(displayName));
  pushLine(identityLines, "Gender", nonEmpty(identity.bio.gender));
  pushLine(identityLines, "Birthday", nonEmpty(identity.bio.birthday));
  pushNumber(identityLines, "Age (biological)", identity.bio.age_biological);
  pushNumber(identityLines, "Age (perceived)", identity.bio.age_perceived);
  pushLine(identityLines, "Nationality", nonEmpty(identity.origin.nationality));
  pushLine(identityLines, "Ethnicity", nonEmpty(identity.origin.ethnicity));
  const birthplaceCity = nonEmpty(identity.origin.birthplace.city);
  const birthplaceCountry = nonEmpty(identity.origin.birthplace.country);
  if (birthplaceCity || birthplaceCountry) {
    pushLine(
      identityLines,
      "Birthplace",
      [birthplaceCity, birthplaceCountry].filter(Boolean).join(", ")
    );
  }
  const residenceCity = nonEmpty(identity.residence.current_city);
  const residenceCountry = nonEmpty(identity.residence.current_country);
  const dwelling = nonEmpty(identity.residence.dwelling_type);
  if (residenceCity || residenceCountry || dwelling) {
    const base = [residenceCity, residenceCountry].filter(Boolean).join(", ");
    const residence = dwelling
      ? base
        ? `${base} (${dwelling})`
        : dwelling
      : base;
    pushLine(identityLines, "Residence", residence);
  }
  appendSection(persona, "Identity", identityLines, includedSections);

  const physicalityLines: string[] = [];
  pushLine(physicalityLines, "Face Shape", nonEmpty(physicality.face.shape));
  const skinTone = nonEmpty(physicality.face.skin.tone);
  const skinTexture = nonEmpty(physicality.face.skin.texture);
  const skinDetails = listToString(physicality.face.skin.details);
  if (skinTone || skinTexture || skinDetails) {
    pushComposite(physicalityLines, "Skin", [
      skinTone,
      skinTexture,
      skinDetails,
    ]);
  }
  const eyesParts = [
    nonEmpty(physicality.face.eyes.color),
    nonEmpty(physicality.face.eyes.shape),
    nonEmpty(physicality.face.eyes.eyebrows),
    nonEmpty(physicality.face.eyes.corrective_lenses),
  ];
  pushComposite(physicalityLines, "Eyes", eyesParts);
  const hairParts = [
    nonEmpty(physicality.face.hair.color),
    nonEmpty(physicality.face.hair.style),
    nonEmpty(physicality.face.hair.texture),
  ];
  pushComposite(physicalityLines, "Hair", hairParts);
  pushLine(
    physicalityLines,
    "Facial Hair",
    nonEmpty(physicality.face.facial_hair)
  );
  pushLine(physicalityLines, "Nose", nonEmpty(physicality.face.nose));
  pushLine(physicalityLines, "Mouth", nonEmpty(physicality.face.mouth));
  pushList(
    physicalityLines,
    "Distinguishing Features",
    physicality.face.distinguishing_features
  );
  pushNumber(physicalityLines, "Height (cm)", physicality.body.height_cm);
  pushNumber(physicalityLines, "Weight (kg)", physicality.body.weight_kg);
  pushLine(
    physicalityLines,
    "Somatotype",
    nonEmpty(physicality.body.somatotype)
  );
  pushLine(
    physicalityLines,
    "Build",
    nonEmpty(physicality.body.build_description)
  );
  pushLine(physicalityLines, "Posture", nonEmpty(physicality.body.posture));
  pushList(physicalityLines, "Scars/Tattoos", physicality.body.scars_tattoos);
  pushLine(
    physicalityLines,
    "Aesthetic Archetype",
    nonEmpty(physicality.style.aesthetic_archetype)
  );
  pushList(
    physicalityLines,
    "Clothing Preferences",
    physicality.style.clothing_preferences
  );
  pushList(physicalityLines, "Accessories", physicality.style.accessories);
  pushList(physicalityLines, "Color Palette", physicality.style.color_palette);
  pushLine(
    physicalityLines,
    "Image Prompt (Portrait)",
    nonEmpty(physicality.image_prompts.portrait)
  );
  pushLine(
    physicalityLines,
    "Image Prompt (Full Body)",
    nonEmpty(physicality.image_prompts.full_body)
  );
  appendSection(persona, "Physicality", physicalityLines, includedSections);

  const psychologyLines: string[] = [];
  const neuralMatrixParts = [
    psychology.neural_matrix.creativity,
    psychology.neural_matrix.empathy,
    psychology.neural_matrix.logic,
    psychology.neural_matrix.adaptability,
    psychology.neural_matrix.charisma,
    psychology.neural_matrix.reliability,
  ];
  if (neuralMatrixParts.some((value) => value !== 0)) {
    psychologyLines.push(
      line(
        "Neural Matrix",
        `creativity ${psychology.neural_matrix.creativity.toFixed(2)}, empathy ${psychology.neural_matrix.empathy.toFixed(
          2
        )}, logic ${psychology.neural_matrix.logic.toFixed(2)}, adaptability ${psychology.neural_matrix.adaptability.toFixed(
          2
        )}, charisma ${psychology.neural_matrix.charisma.toFixed(2)}, reliability ${psychology.neural_matrix.reliability.toFixed(
          2
        )}`
      )
    );
  }
  const oceanParts = [
    psychology.traits.ocean.openness,
    psychology.traits.ocean.conscientiousness,
    psychology.traits.ocean.extraversion,
    psychology.traits.ocean.agreeableness,
    psychology.traits.ocean.neuroticism,
  ];
  if (oceanParts.some((value) => value !== 0)) {
    psychologyLines.push(
      line(
        "OCEAN",
        `openness ${psychology.traits.ocean.openness.toFixed(2)}, conscientiousness ${psychology.traits.ocean.conscientiousness.toFixed(
          2
        )}, extraversion ${psychology.traits.ocean.extraversion.toFixed(2)}, agreeableness ${psychology.traits.ocean.agreeableness.toFixed(
          2
        )}, neuroticism ${psychology.traits.ocean.neuroticism.toFixed(2)}`
      )
    );
  }
  pushLine(psychologyLines, "MBTI", nonEmpty(psychology.traits.mbti));
  pushLine(psychologyLines, "Enneagram", nonEmpty(psychology.traits.enneagram));
  pushLine(
    psychologyLines,
    "Temperament",
    nonEmpty(psychology.traits.temperament)
  );
  pushLine(
    psychologyLines,
    "Alignment",
    nonEmpty(psychology.moral_compass.alignment)
  );
  pushList(
    psychologyLines,
    "Core Values",
    psychology.moral_compass.core_values
  );
  pushLine(
    psychologyLines,
    "Conflict Resolution",
    nonEmpty(psychology.moral_compass.conflict_resolution_style)
  );
  pushLine(
    psychologyLines,
    "Decision Making",
    nonEmpty(psychology.mental_patterns.decision_making_style)
  );
  pushLine(
    psychologyLines,
    "Attention Span",
    nonEmpty(psychology.mental_patterns.attention_span)
  );
  pushLine(
    psychologyLines,
    "Learning Style",
    nonEmpty(psychology.mental_patterns.learning_style)
  );
  pushLine(
    psychologyLines,
    "Base Mood",
    nonEmpty(psychology.emotional_profile.base_mood)
  );
  pushNumber(
    psychologyLines,
    "Volatility",
    psychology.emotional_profile.volatility,
    2
  );
  pushLine(
    psychologyLines,
    "Resilience",
    nonEmpty(psychology.emotional_profile.resilience)
  );
  pushList(
    psychologyLines,
    "Joy Triggers",
    psychology.emotional_profile.triggers.joy
  );
  pushList(
    psychologyLines,
    "Anger Triggers",
    psychology.emotional_profile.triggers.anger
  );
  pushList(
    psychologyLines,
    "Sadness Triggers",
    psychology.emotional_profile.triggers.sadness
  );
  pushList(psychologyLines, "Phobias", psychology.idiosyncrasies.phobias);
  pushList(psychologyLines, "Obsessions", psychology.idiosyncrasies.obsessions);
  pushList(psychologyLines, "Tics", psychology.idiosyncrasies.tics);
  appendSection(persona, "Psychology", psychologyLines, includedSections);

  const linguisticsLines: string[] = [];
  pushLine(
    linguisticsLines,
    "TTS Provider",
    nonEmpty(linguistics.voice.tts_config.provider)
  );
  pushLine(
    linguisticsLines,
    "TTS Voice ID",
    nonEmpty(linguistics.voice.tts_config.voice_id)
  );
  pushNumber(
    linguisticsLines,
    "TTS Stability",
    linguistics.voice.tts_config.stability,
    2
  );
  pushNumber(
    linguisticsLines,
    "TTS Similarity",
    linguistics.voice.tts_config.similarity_boost,
    2
  );
  const acousticsParts = [
    nonEmpty(linguistics.voice.acoustics.pitch),
    nonEmpty(linguistics.voice.acoustics.speed),
    linguistics.voice.acoustics.roughness !== 0
      ? `roughness ${linguistics.voice.acoustics.roughness.toFixed(2)}`
      : undefined,
    linguistics.voice.acoustics.breathiness !== 0
      ? `breathiness ${linguistics.voice.acoustics.breathiness.toFixed(2)}`
      : undefined,
  ];
  pushComposite(linguisticsLines, "Acoustics", acousticsParts);
  const accentRegion = nonEmpty(linguistics.voice.accent.region);
  const accentStrength = linguistics.voice.accent.strength;
  if (accentRegion || accentStrength !== 0) {
    const accent = accentRegion
      ? `${accentRegion}${accentStrength !== 0 ? ` (${accentStrength.toFixed(2)})` : ""}`
      : `strength ${accentStrength.toFixed(2)}`;
    pushLine(linguisticsLines, "Accent", accent);
  }
  pushNumber(linguisticsLines, "Formality", formality, 2, true);
  pushNumber(linguisticsLines, "Verbosity", verbosity, 2, true);
  pushLine(
    linguisticsLines,
    "Vocabulary",
    nonEmpty(textStyle.vocabulary_level)
  );
  pushBoolean(linguisticsLines, "Slang Usage", textStyle.slang_usage);
  if (styleDescriptors) {
    pushLine(linguisticsLines, "Style Descriptors", styleDescriptors);
  }
  pushLine(
    linguisticsLines,
    "Sentence Structure",
    nonEmpty(linguistics.syntax.sentence_structure)
  );
  pushBoolean(
    linguisticsLines,
    "Use Contractions",
    linguistics.syntax.use_contractions
  );
  pushNumber(
    linguisticsLines,
    "Active/Passive Ratio",
    linguistics.syntax.active_passive_ratio,
    2
  );
  pushLine(
    linguisticsLines,
    "Turn Taking",
    nonEmpty(linguistics.interaction.turn_taking)
  );
  pushNumber(
    linguisticsLines,
    "Dominance Score",
    linguistics.interaction.dominance_score,
    2
  );
  pushLine(
    linguisticsLines,
    "Emotional Coloring",
    nonEmpty(linguistics.interaction.emotional_coloring)
  );
  pushList(linguisticsLines, "Catchphrases", linguistics.idiolect.catchphrases);
  pushList(
    linguisticsLines,
    "Forbidden Words",
    linguistics.idiolect.forbidden_words
  );
  pushBoolean(
    linguisticsLines,
    "Hesitation Markers",
    linguistics.idiolect.hesitation_markers
  );
  appendSection(persona, "Linguistics", linguisticsLines, includedSections);

  const historyLines: string[] = [];
  pushLine(historyLines, "Origin Story", nonEmpty(history.origin_story));
  pushLine(historyLines, "Education", nonEmpty(history.education.level));
  pushLine(historyLines, "Field", nonEmpty(history.education.field));
  pushLine(
    historyLines,
    "Institution",
    nonEmpty(history.education.institution)
  );
  pushNumber(
    historyLines,
    "Graduation Year",
    history.education.graduation_year
  );
  pushLine(historyLines, "Occupation", nonEmpty(history.occupation.title));
  pushLine(historyLines, "Industry", nonEmpty(history.occupation.industry));
  pushNumber(
    historyLines,
    "Years Experience",
    history.occupation.years_experience
  );
  pushList(historyLines, "Previous Jobs", history.occupation.previous_jobs);
  pushLine(
    historyLines,
    "Relationship Status",
    nonEmpty(history.family.relationship_status)
  );
  pushLine(historyLines, "Parents", nonEmpty(history.family.parents));
  pushLine(historyLines, "Siblings", nonEmpty(history.family.siblings));
  pushLine(historyLines, "Children", nonEmpty(history.family.children));
  pushLine(historyLines, "Pets", nonEmpty(history.family.pets));
  history.key_life_events.forEach((event, index) => {
    const eventLines: string[] = [];
    pushNumber(eventLines, "Year", event.year, undefined, true);
    pushLine(eventLines, "Event", nonEmpty(event.event));
    pushLine(eventLines, "Impact", nonEmpty(event.impact));
    if (eventLines.length > 0) {
      historyLines.push(`Key Life Event ${index + 1}`);
      historyLines.push(...eventLines.map((entry) => `  ${entry}`));
    }
  });
  appendSection(persona, "History", historyLines, includedSections);

  const interestsLines: string[] = [];
  pushList(interestsLines, "Hobbies", interests.hobbies);
  pushLine(
    interestsLines,
    "Favorite Music",
    nonEmpty(interests.favorites.music_genre)
  );
  pushLine(interestsLines, "Favorite Book", nonEmpty(interests.favorites.book));
  pushLine(
    interestsLines,
    "Favorite Movie",
    nonEmpty(interests.favorites.movie)
  );
  pushLine(
    interestsLines,
    "Favorite Color",
    nonEmpty(interests.favorites.color)
  );
  pushLine(interestsLines, "Favorite Food", nonEmpty(interests.favorites.food));
  pushLine(
    interestsLines,
    "Favorite Season",
    nonEmpty(interests.favorites.season)
  );
  pushList(interestsLines, "Aversions", interests.aversions);
  pushLine(interestsLines, "Diet", nonEmpty(interests.lifestyle.diet));
  pushLine(
    interestsLines,
    "Sleep Schedule",
    nonEmpty(interests.lifestyle.sleep_schedule)
  );
  pushLine(
    interestsLines,
    "Digital Habits",
    nonEmpty(interests.lifestyle.digital_habits)
  );
  appendSection(persona, "Interests", interestsLines, includedSections);

  const motivationsLines: string[] = [];
  pushLine(motivationsLines, "Core Drive", nonEmpty(motivations.core_drive));
  pushList(
    motivationsLines,
    "Goals (short-term)",
    motivations.goals.short_term
  );
  pushList(motivationsLines, "Goals (long-term)", motivations.goals.long_term);
  pushList(motivationsLines, "Fears (rational)", motivations.fears.rational);
  pushList(
    motivationsLines,
    "Fears (irrational)",
    motivations.fears.irrational
  );
  appendSection(persona, "Motivations", motivationsLines, includedSections);

  const prompt = persona.join("\n");
  logger.debug("AIEOS prompt built", {
    sections: includedSections,
    sectionCount: includedSections.length,
    lineCount: prompt.split("\n").length,
    length: prompt.length,
  });

  return prompt;
};
