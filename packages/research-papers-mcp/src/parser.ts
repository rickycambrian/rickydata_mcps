// HTML + PDF parser for arXiv research papers

import { parseDocument } from "htmlparser2";
import { findAll, textContent } from "domutils";
import type { Element } from "domhandler";

// ── Types ──────────────────────────────────────────────────────────────────

export type SectionType =
  | "abstract"
  | "introduction"
  | "related_work"
  | "methodology"
  | "experiments"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "other";

export interface PaperSection {
  type: SectionType;
  heading: string;
  text: string;
  ordinal: number;
}

export interface PaperChunk {
  sectionType: SectionType;
  sectionHeading: string;
  ordinal: number;
  chunkIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface StoredPaperArtifact {
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  published: string;
  categories: string[];
  sections: PaperSection[];
  chunks: PaperChunk[];
  guide: PaperGuide;
  rawText: string;
  fetchedAt: string;
  sourceFormat: "html" | "pdf";
}

export interface PaperGuide {
  sectionOutline: string[];
  keyTerms: string[];
  recommendedQueries: string[];
  quality: {
    sectionCount: number;
    totalChars: number;
    hasAbstract: boolean;
    hasReferences: boolean;
  };
}

// ── Section Aliases ────────────────────────────────────────────────────────

const SECTION_ALIASES: Record<string, SectionType> = {
  // abstract
  abstract: "abstract",
  summary: "abstract",
  // introduction
  introduction: "introduction",
  intro: "introduction",
  background: "introduction",
  motivation: "introduction",
  overview: "introduction",
  "1 introduction": "introduction",
  "1. introduction": "introduction",
  // related work
  "related work": "related_work",
  "related works": "related_work",
  "literature review": "related_work",
  "prior work": "related_work",
  "previous work": "related_work",
  "background and related work": "related_work",
  // methodology
  methodology: "methodology",
  method: "methodology",
  methods: "methodology",
  approach: "methodology",
  "our approach": "methodology",
  "proposed method": "methodology",
  "the model": "methodology",
  model: "methodology",
  framework: "methodology",
  "problem formulation": "methodology",
  formulation: "methodology",
  "technical approach": "methodology",
  // experiments
  experiments: "experiments",
  "experimental setup": "experiments",
  "experimental results": "experiments",
  "experimental evaluation": "experiments",
  evaluation: "experiments",
  setup: "experiments",
  "experiments and results": "experiments",
  // results
  results: "results",
  "main results": "results",
  "quantitative results": "results",
  "qualitative results": "results",
  findings: "results",
  "ablation study": "results",
  ablations: "results",
  analysis: "results",
  // discussion
  discussion: "discussion",
  "discussion and analysis": "discussion",
  "limitations and future work": "discussion",
  limitations: "discussion",
  "future work": "discussion",
  "broader impact": "discussion",
  "ethical considerations": "discussion",
  // conclusion
  conclusion: "conclusion",
  conclusions: "conclusion",
  "concluding remarks": "conclusion",
  "conclusion and future work": "conclusion",
  "summary and conclusions": "conclusion",
  // references
  references: "references",
  bibliography: "references",
  "works cited": "references",
};

function classifyHeading(heading: string): SectionType {
  const normalized = heading.toLowerCase().trim();
  // Strip leading numbering like "1.", "2.1", "A."
  const stripped = normalized.replace(/^[\d]+\.[\d.]*\s*/, "").replace(/^[a-z]\.\s*/i, "").trim();
  return (
    SECTION_ALIASES[normalized] ||
    SECTION_ALIASES[stripped] ||
    "other"
  );
}

// ── HTML Parser ────────────────────────────────────────────────────────────

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4"]);
const BLOCK_TAGS = new Set(["p", "section", "div", "li", "td", "th", "blockquote", "pre", "figure", "figcaption"]);

export function parseHtml(html: string): PaperSection[] {
  const dom = parseDocument(html);

  // Collect all block-level elements in document order
  const allElements = findAll(() => true, dom.children);

  // Walk elements and group by section headings
  const sections: PaperSection[] = [];
  let currentHeading = "Preamble";
  let currentType: SectionType = "other";
  let currentTexts: string[] = [];
  let ordinal = 0;

  function pushSection() {
    const text = currentTexts.join(" ").replace(/\s+/g, " ").trim();
    if (text.length > 20) {
      sections.push({
        type: currentType,
        heading: currentHeading,
        text,
        ordinal: ordinal++,
      });
    }
    currentTexts = [];
  }

  for (const el of allElements) {
    const elem = el as Element;
    if (!elem.tagName) continue;
    const tag = elem.tagName.toLowerCase();

    if (HEADING_TAGS.has(tag)) {
      const hText = textContent(elem).replace(/\s+/g, " ").trim();
      if (!hText) continue;

      // Flush current section
      pushSection();

      currentHeading = hText;
      currentType = classifyHeading(hText);
    } else if (BLOCK_TAGS.has(tag)) {
      const t = textContent(elem).replace(/\s+/g, " ").trim();
      if (t.length > 0) {
        currentTexts.push(t);
      }
    }
  }

  // Flush last section
  pushSection();

  return sections;
}

// ── PDF Parser ─────────────────────────────────────────────────────────────

const NUMBERED_HEADING = /^\s*(\d+\.?\d*)\s+([A-Z][a-zA-Z\s]{2,})/m;
const ALLCAPS_HEADING = /^[A-Z][A-Z\s]{2,49}$/m;

export async function parsePdf(buffer: Buffer): Promise<PaperSection[]> {
  // Dynamic import — pdf-parse has no ESM default export in some versions
  const pdfParse = (await import("pdf-parse")).default;
  const result = await pdfParse(buffer);
  const rawText: string = result.text;

  return splitPdfText(rawText);
}

function splitPdfText(rawText: string): PaperSection[] {
  const lines = rawText.split("\n");
  const sections: PaperSection[] = [];
  let currentHeading = "Preamble";
  let currentType: SectionType = "other";
  let currentLines: string[] = [];
  let ordinal = 0;

  function pushSection() {
    const text = currentLines.join(" ").replace(/\s+/g, " ").trim();
    if (text.length > 20) {
      sections.push({
        type: currentType,
        heading: currentHeading,
        text,
        ordinal: ordinal++,
      });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isNumberedHeading = NUMBERED_HEADING.test(trimmed) && trimmed.length < 80;
    const isAllCapsHeading = ALLCAPS_HEADING.test(trimmed) && trimmed.length < 60;

    if (isNumberedHeading || isAllCapsHeading) {
      pushSection();
      currentHeading = trimmed;
      currentType = classifyHeading(trimmed);
    } else {
      currentLines.push(trimmed);
    }
  }

  pushSection();

  // Heuristic: if first section has "abstract" in text and wasn't labeled
  if (sections.length > 0 && sections[0].type === "other") {
    const lc = sections[0].text.toLowerCase();
    if (lc.startsWith("abstract") || lc.includes("in this paper") || lc.includes("we propose")) {
      sections[0] = { ...sections[0], type: "abstract", heading: "Abstract" };
    }
  }

  // Heuristic: last section is likely references
  if (sections.length > 1) {
    const last = sections[sections.length - 1];
    if (last.type === "other") {
      const lc = last.text;
      // References section typically has many author names and years
      const yearMatches = (lc.match(/\b(19|20)\d{2}\b/g) || []).length;
      if (yearMatches > 5) {
        sections[sections.length - 1] = { ...last, type: "references", heading: "References" };
      }
    }
  }

  return sections;
}

// ── Chunking ───────────────────────────────────────────────────────────────

const CHUNK_SIZE_CHARS = 2000; // ~500 tokens

export function chunkSections(sections: PaperSection[]): PaperChunk[] {
  const chunks: PaperChunk[] = [];
  let globalOrdinal = 0;

  for (const section of sections) {
    const text = section.text;
    const chunkCount = Math.ceil(text.length / CHUNK_SIZE_CHARS);

    for (let i = 0; i < chunkCount; i++) {
      const charStart = i * CHUNK_SIZE_CHARS;
      const charEnd = Math.min(charStart + CHUNK_SIZE_CHARS, text.length);
      chunks.push({
        sectionType: section.type,
        sectionHeading: section.heading,
        ordinal: globalOrdinal++,
        chunkIndex: i,
        text: text.slice(charStart, charEnd),
        charStart,
        charEnd,
      });
    }
  }

  return chunks;
}

// ── TF-IDF Key Terms ───────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'when', 'where', 'what', 'your', 'have',
  'been', 'being', 'does', 'done', 'each', 'every', 'both', 'either', 'neither', 'such', 'those', 'these',
  'which', 'while', 'since', 'before', 'after', 'during', 'between', 'through', 'above', 'below', 'over',
  'under', 'then', 'only', 'also', 'back', 'here', 'there', 'them', 'they', 'their', 'other', 'some',
  'need', 'about', 'using', 'use', 'used', 'are', 'was', 'were', 'will', 'can', 'could', 'should',
  'would', 'might', 'must', 'shall', 'make', 'made', 'take', 'took', 'come', 'came', 'give', 'gave',
  'say', 'said', 'tell', 'told', 'look', 'see', 'seen', 'want', 'know', 'think', 'going', 'went', 'goes',
  'get', 'got', 'gets', 'getting', 'put', 'set', 'let', 'keep', 'kept', 'start', 'started', 'call', 'called',
  'try', 'tried', 'turn', 'show', 'shown', 'find', 'found', 'work', 'working', 'mean', 'means',
  'you', 'like', 'just', 'very', 'much', 'more', 'most', 'than', 'yeah', 'yes', 'okay', 'right',
  'actually', 'basically', 'really', 'pretty', 'stuff', 'thing', 'things', 'kind', 'sort', 'way',
  'well', 'even', 'still', 'already', 'maybe', 'probably', 'definitely', 'literally', 'essentially',
  'one', 'two', 'three', 'four', 'five', 'first', 'second', 'third', 'last', 'next',
  'part', 'chapter', 'section', 'point', 'result', 'results', 'show', 'shows', 'paper', 'papers',
  'figure', 'table', 'equation', 'algorithm', 'appendix', 'model', 'data', 'number', 'time',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function extractBigrams(text: string, minCount = 2): Map<string, number> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  const freq = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i];
    const b = words[i + 1];
    if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
    if (a.length < 3 || b.length < 3) continue;
    const bigram = `${a} ${b}`;
    freq.set(bigram, (freq.get(bigram) ?? 0) + 1);
  }
  for (const [key, count] of freq) {
    if (count < minCount) freq.delete(key);
  }
  return freq;
}

function extractKeyTerms(text: string, limit = 12): string[] {
  const freq = new Map<string, number>();
  for (const token of tokenize(text)) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  const bigrams = extractBigrams(text, 2);
  const results: Array<{ term: string; score: number }> = [];

  for (const [bigram, count] of bigrams) {
    results.push({ term: bigram, score: count * 1.5 });
  }

  const bigramTokens = new Set<string>();
  for (const [bigram] of bigrams) {
    for (const part of bigram.split(' ')) bigramTokens.add(part);
  }
  for (const [term, count] of freq) {
    if (!bigramTokens.has(term)) {
      results.push({ term, score: count });
    }
  }

  results.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  return results.slice(0, limit).map(({ term }) => term);
}

// ── Guide Builder ──────────────────────────────────────────────────────────

export function buildGuide(sections: PaperSection[], rawText: string): PaperGuide {
  const sectionOutline = sections.map(
    (s) => `[${s.type}] ${s.heading}`
  );

  const keyTerms = extractKeyTerms(rawText, 12);

  // Recommend queries based on section types present
  const sectionTypes = new Set(sections.map((s) => s.type));
  const recommendedQueries: string[] = [];
  if (sectionTypes.has("methodology")) {
    recommendedQueries.push("What methodology or approach is proposed?");
  }
  if (sectionTypes.has("experiments") || sectionTypes.has("results")) {
    recommendedQueries.push("What are the main experimental results?");
  }
  if (sectionTypes.has("related_work")) {
    recommendedQueries.push("How does this compare to prior work?");
  }
  if (sectionTypes.has("conclusion")) {
    recommendedQueries.push("What are the main conclusions and contributions?");
  }
  if (sectionTypes.has("discussion")) {
    recommendedQueries.push("What are the limitations and future directions?");
  }
  if (keyTerms.length > 0) {
    recommendedQueries.push(`Search for: ${keyTerms.slice(0, 3).join(", ")}`);
  }

  const quality = {
    sectionCount: sections.length,
    totalChars: rawText.length,
    hasAbstract: sectionTypes.has("abstract"),
    hasReferences: sectionTypes.has("references"),
  };

  return { sectionOutline, keyTerms, recommendedQueries, quality };
}
