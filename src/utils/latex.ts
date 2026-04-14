import { AttachmentBuilder } from "discord.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import sharp from "sharp";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({ packages: AllPackages });
const svgOutput = new SVG({ fontCache: "local" });

const RENDER_DENSITY = 300;
const PADDING = 16;
const MAX_WIDTH = 800;
const BG_COLOR: sharp.Color = { r: 43, g: 45, b: 49, alpha: 255 };
const TEXT_COLOR = "#dbdee1";
const MAX_LATEX_LENGTH = 2000;

// fenced latex block: ```latex\n...\n```
// tolerant of trailing content on the opener line (e.g. ```latex whatever\n)
const LATEX_FENCE_REGEX = /```latex[^\n]*\n([\s\S]*?)\n?```/gi;
const PLACEHOLDER = (i: number) => `\x00LATEX_${i}\x00`;

function renderToSvg(latex: string): string {
  const doc = mathjax.document("", {
    InputJax: tex,
    OutputJax: svgOutput,
  });
  const node = doc.convert(latex, { display: true });
  let svg = adaptor.innerHTML(node);
  svg = svg.replace(/fill="currentColor"/g, `fill="${TEXT_COLOR}"`);
  return svg;
}

async function svgToPng(svg: string): Promise<Buffer> {
  const { data, info } = await sharp(Buffer.from(svg), {
    density: RENDER_DENSITY,
  })
    .resize({ width: MAX_WIDTH - PADDING * 2, withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });

  return sharp({
    create: {
      width: info.width + PADDING * 2,
      height: info.height + PADDING * 2,
      channels: 4,
      background: BG_COLOR,
    },
  })
    .composite([{ input: data, left: PADDING, top: PADDING }])
    .png()
    .toBuffer();
}

interface LatexExpr {
  placeholder: string;
  latex: string;
  filename: string;
}

export interface LatexResult {
  text: string;
  files: AttachmentBuilder[];
}

export async function renderLatex(text: string): Promise<LatexResult> {
  if (!/```latex/i.test(text)) {
    return { text, files: [] };
  }

  const expressions: LatexExpr[] = [];

  const masked = text.replace(LATEX_FENCE_REGEX, (match, latex: string) => {
    const trimmed = latex.trim();
    // skip empty or oversized blocks — leave the fence as-is
    if (trimmed.length === 0 || trimmed.length > MAX_LATEX_LENGTH) {
      return match;
    }
    const i = expressions.length;
    const placeholder = PLACEHOLDER(i);
    expressions.push({
      placeholder,
      latex: trimmed,
      filename: `latex-${i}.png`,
    });
    return placeholder;
  });

  if (expressions.length === 0) {
    return { text, files: [] };
  }

  const renderResults = await Promise.allSettled(
    expressions.map(async (expr) => svgToPng(renderToSvg(expr.latex)))
  );

  const files: AttachmentBuilder[] = [];
  const replacements = new Map<string, string>();

  for (let i = 0; i < renderResults.length; i++) {
    const settled = renderResults[i];
    const expr = expressions[i];
    if (!settled || !expr) continue;
    if (settled.status === "fulfilled") {
      files.push(new AttachmentBuilder(settled.value, { name: expr.filename }));
      replacements.set(
        expr.placeholder,
        `![equation](attachment://${expr.filename})`
      );
    } else {
      // render failed — restore the original fence so the user sees the source
      replacements.set(expr.placeholder, `\`\`\`latex\n${expr.latex}\n\`\`\``);
    }
  }

  // split/join avoids String.replace treating `$1`, `$&` in replacements as backrefs
  let output = masked;
  for (const [placeholder, replacement] of replacements) {
    output = output.split(placeholder).join(replacement);
  }

  return { text: output, files };
}
