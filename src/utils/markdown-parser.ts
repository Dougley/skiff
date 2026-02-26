import type { APIMediaGalleryItem } from "discord.js";
import {
  MediaGalleryBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";

export type TopLevelComponent =
  | TextDisplayBuilder
  | MediaGalleryBuilder
  | SeparatorBuilder;

const HR_REGEX = /^[-*_]{3,}$/;
const IMAGE_LINK_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/; // no 'g' flag — used only for .test()
const VALID_MEDIA_URL_REGEX = /^https?:\/\//i;
const MAX_GALLERY_ITEMS = 10;
const MAX_COMPONENTS_PER_MESSAGE = 40;
const MAX_TEXT_CHARS_PER_MESSAGE = 4000;

// split a large code fence into multiple fence blocks, each within MAX_TEXT_CHARS_PER_MESSAGE
function splitCodeFence(fenceLines: string[]): string[] {
  const full = fenceLines.join("\n");
  if (full.length <= MAX_TEXT_CHARS_PER_MESSAGE) return [full];
  
  const openLine = fenceLines[0];
  const lastLine = fenceLines[fenceLines.length - 1] ?? "";
  const isClosed = fenceLines.length > 1 && lastLine.trimStart().startsWith("```");
  const closeLine = "```";
  const bodyLines = isClosed ? fenceLines.slice(1, -1) : fenceLines.slice(1);
  
  const result: string[] = [];
  let chunk: string[] = [];
  
  for (const line of bodyLines) {
    chunk.push(line);
    const candidate = [openLine, ...chunk, closeLine].join("\n");
    if (candidate.length > MAX_TEXT_CHARS_PER_MESSAGE && chunk.length > 1) {
      chunk.pop();
      result.push([openLine, ...chunk, closeLine].join("\n"));
      chunk = [line];
    }
  }
  
  const finalLines = isClosed ? [openLine, ...chunk, closeLine] : [openLine, ...chunk];
  result.push(finalLines.join("\n"));
  return result;
}

// split markdown into paragraphs; code fences become their own segments
function splitParagraphs(markdown: string): string[] {
  const lines = markdown.split("\n");
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fence: string[] = [];
  let inFence = false;
  let fenceTickCount = 0;

  for (const line of lines) {
    const stripped = line.trimStart();
    const tickMatch = stripped.match(/^(`{3,})/);

    if (tickMatch) {
      const tickCount = tickMatch[0].length;
      if (!inFence) {
        // flush preceding text paragraph before starting the fence
        if (current.length > 0) {
          paragraphs.push(current.join("\n"));
          current = [];
        }
        inFence = true;
        fenceTickCount = tickCount;
        fence = [line];
        continue;
      } else if (tickCount >= fenceTickCount && stripped.slice(tickCount).trim() === "") {
        // closing fence: >= opener's backtick count, nothing after them
        fence.push(line);
        for (const chunk of splitCodeFence(fence)) paragraphs.push(chunk);
        fence = [];
        inFence = false;
        fenceTickCount = 0;
        continue;
      }
      // fewer backticks or has trailing content — treat as fence body
    }

    if (inFence) {
      fence.push(line);
    } else if (line.trim() === "") {
      if (current.length > 0) {
        paragraphs.push(current.join("\n"));
        current = [];
      }
    } else {
      current.push(line);
    }
  }

  if (fence.length > 0) for (const chunk of splitCodeFence(fence)) paragraphs.push(chunk); // unclosed fence
  if (current.length > 0) paragraphs.push(current.join("\n"));
  return paragraphs;
}

/**
 * Parses markdown into Discord Components V2 builders.
 *
 * - Text becomes TextDisplayBuilder
 * - Image links (![alt](url)) become MediaGalleryBuilder
 * - Images in the same paragraph are grouped into one gallery (max 10)
 * - Horizontal rules (---, ***, ___) become SeparatorBuilder
 * - Other markdown formatting is not currently supported and will be treated as plain text
 */
export function markdownToDiscordComponents(
  markdown: string
): TopLevelComponent[] {
  const components: TopLevelComponent[] = [];
  const paragraphs = splitParagraphs(markdown);
  
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (HR_REGEX.test(trimmed)) {
      components.push(new SeparatorBuilder());
      continue;
    }

    if (!IMAGE_LINK_REGEX.test(trimmed)) {
      components.push(new TextDisplayBuilder().setContent(trimmed));
      continue;
    }

    // Paragraph contains images — split into text chunks and image groups
    // fresh global instance each time so lastIndex never leaks between paragraphs
    const imageRegex = new RegExp(IMAGE_LINK_REGEX.source, "g");
    let lastIndex = 0;
    let images: { url: string; alt: string }[] = [];

    for (
      let match = imageRegex.exec(trimmed);
      match !== null;
      match = imageRegex.exec(trimmed)
    ) {
      const textBefore = trimmed.slice(lastIndex, match.index).trim();
      if (textBefore) {
        // Flush accumulated images before emitting text
        if (images.length > 0) {
          pushGallery(components, images);
          images = [];
        }
        components.push(new TextDisplayBuilder().setContent(textBefore));
      }

      images.push({ url: match[2] ?? "", alt: match[1] ?? "" });
      lastIndex = match.index + match[0].length;
    }

    // Flush remaining images
    if (images.length > 0) {
      pushGallery(components, images);
    }

    // Any trailing text after the last image
    const trailing = trimmed.slice(lastIndex).trim();
    if (trailing) {
      components.push(new TextDisplayBuilder().setContent(trailing));
    }
  }

  return components;
}

/**
 * Splits a flat list of components into message-sized chunks,
 * respecting Discord's per-message limits:
 * - Max 40 components per message
 * - Max 4000 characters total across all text display components
 */
export function splitComponentMessages(
  components: TopLevelComponent[]
): TopLevelComponent[][] {
  const messages: TopLevelComponent[][] = [];
  let current: TopLevelComponent[] = [];
  let textChars = 0;

  for (const component of components) {
    const isText = component instanceof TextDisplayBuilder;
    const charCount = isText ? component.toJSON().content.length : 0;

    const wouldExceedComponents = current.length >= MAX_COMPONENTS_PER_MESSAGE;
    const wouldExceedChars =
      isText && textChars + charCount > MAX_TEXT_CHARS_PER_MESSAGE;

    if (current.length > 0 && (wouldExceedComponents || wouldExceedChars)) {
      messages.push(current);
      current = [];
      textChars = 0;
    }

    current.push(component);
    textChars += charCount;
  }

  if (current.length > 0) {
    messages.push(current);
  }

  return messages;
}

function pushGallery(
  components: TopLevelComponent[],
  images: { url: string; alt: string }[]
) {
  const valid = images.filter((img) => VALID_MEDIA_URL_REGEX.test(img.url));
  if (valid.length === 0) {
    // Fall back to text with markdown links for invalid URLs
    const text = images
      .map((img) => (img.alt ? `[${img.alt}](${img.url})` : img.url))
      .join("\n");
    components.push(new TextDisplayBuilder().setContent(text));
    return;
  }

  for (let i = 0; i < valid.length; i += MAX_GALLERY_ITEMS) {
    const chunk = valid.slice(i, i + MAX_GALLERY_ITEMS);
    const gallery = new MediaGalleryBuilder();
    const items: APIMediaGalleryItem[] = chunk.map((img) => ({
      media: { url: img.url },
      description: img.alt.slice(0, 1024) || undefined,
    }));
    gallery.addItems(...items);
    components.push(gallery);
  }
}
