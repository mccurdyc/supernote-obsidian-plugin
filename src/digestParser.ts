export interface DigestHighlight {
  content: string;
  page: number;
  chapter: string;
}

export interface DigestBook {
  title: string;
  author: string;
  year: string;
  category: string;
  highlights: DigestHighlight[];
}

interface ParsedBlock {
  path: string;
  page: number;
  chapter: string;
  charStart: number;
  modifyTime: number;
  content: string;
}

function deriveCategory(path: string): string {
  if (path.includes("/Books/")) return "#books";
  if (path.includes("/Articles/")) return "#articles";
  if (
    path.includes("/Documents/") ||
    path.includes("/Document/")
  ) {
    return "#documents";
  }
  return "#highlights";
}

function parsePathSegments(
  path: string,
): { title: string; author: string; year: string } | null {
  const fileProto = "file://";
  const raw = path.startsWith(fileProto)
    ? path.slice(fileProto.length)
    : path;

  const lastSlash = raw.lastIndexOf("/");
  const filename =
    lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;

  // Strip file extension
  const dotIdx = filename.lastIndexOf(".");
  const base = dotIdx >= 0
    ? filename.slice(0, dotIdx)
    : filename;

  const segments = base.split("--").map((s) => s.trim());
  if (segments.length < 3) return null;

  const title = segments[0];
  const author = segments[1];

  const editionYear = segments[2];
  const parts = editionYear.split(",").map((p) => p.trim());
  const year =
    parts.length >= 2 ? parts[parts.length - 1] : parts[0];

  return { title, author, year };
}

function extractField(
  block: string,
  field: string,
): string | null {
  // Support both flat ("linkinfo.path:") and nested
  // ("linkinfo:\n  path:") formats. For nested fields
  // like "linkinfo.path", extract the leaf key "path".
  const parts = field.split(".");
  const leafKey = parts[parts.length - 1];
  const prefix = `${leafKey}:`;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return null;
}

function extractContent(block: string): string | null {
  const marker = "content:\n";
  const idx = block.indexOf(marker);
  if (idx < 0) return null;

  const raw = block.slice(idx + marker.length);
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return lines.length > 0 ? lines.join(" ") : null;
}

function parseChapterNumber(chapter: string): string {
  const dash = chapter.indexOf("-");
  return dash >= 0 ? chapter.slice(0, dash) : chapter;
}

function parseCharStart(chapter: string): number {
  const match = chapter.match(/\[(\d+)-/);
  return match ? parseInt(match[1], 10) : 0;
}

function parseBlock(raw: string): ParsedBlock | null {
  const path = extractField(raw, "linkinfo.path");
  const pageStr = extractField(raw, "linkinfo.page");
  const chapter = extractField(
    raw, "linkinfo.chapter",
  );
  const content = extractContent(raw);

  if (!path || !pageStr || !content) {
    return null;
  }

  const page = parseInt(pageStr, 10);
  if (isNaN(page)) return null;

  const charStart = chapter
    ? parseCharStart(chapter)
    : 0;

  const modifyTimeStr = extractField(
    raw, "modify_time.timestamp",
  );
  const modifyTime = modifyTimeStr
    ? parseInt(modifyTimeStr, 10)
    : 0;

  return {
    path, page, chapter: chapter || "",
    charStart, modifyTime, content,
  };
}

export function parseDigest(text: string): DigestBook[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Strip outer brackets and split on block boundaries
  const inner = trimmed.startsWith("[")
    ? trimmed.slice(1)
    : trimmed;
  const stripped = inner.endsWith("]")
    ? inner.slice(0, -1)
    : inner;

  const rawBlocks = stripped.split("]\n\n[");

  const bookMap = new Map<
    string,
    {
      title: string;
      author: string;
      year: string;
      category: string;
      highlights: (DigestHighlight & {
        charStart: number;
        modifyTime: number;
      })[];
    }
  >();

  for (const raw of rawBlocks) {
    const parsed = parseBlock(raw);
    if (!parsed) continue;

    const meta = parsePathSegments(parsed.path);
    if (!meta) continue;

    const key = `${meta.title}\0${meta.author}`;
    const chapterNum = parseChapterNumber(parsed.chapter);
    const category = deriveCategory(parsed.path);

    if (!bookMap.has(key)) {
      bookMap.set(key, {
        title: meta.title,
        author: meta.author,
        year: meta.year,
        category,
        highlights: [],
      });
    }

    bookMap.get(key)!.highlights.push({
      content: parsed.content,
      page: parsed.page,
      chapter: chapterNum,
      charStart: parsed.charStart,
      modifyTime: parsed.modifyTime,
    });
  }

  const books: DigestBook[] = [];
  for (const entry of bookMap.values()) {
    entry.highlights.sort((a, b) => {
      // Sort by chapter first (if chapters exist)
      const chA = parseInt(a.chapter, 10);
      const chB = parseInt(b.chapter, 10);
      const hasChA = !isNaN(chA);
      const hasChB = !isNaN(chB);
      if (hasChA && hasChB && chA !== chB) {
        return chA - chB;
      }
      // Then by page
      if (a.page !== b.page) return a.page - b.page;
      // Then by modify time
      if (a.modifyTime !== b.modifyTime) {
        return a.modifyTime - b.modifyTime;
      }
      return a.charStart - b.charStart;
    });

    books.push({
      title: entry.title,
      author: entry.author,
      year: entry.year,
      category: entry.category,
      highlights: entry.highlights.map(
        ({ charStart: _, modifyTime: __, ...h }) => h,
      ),
    });
  }

  return books;
}

export function generateDigestMarkdown(
  book: DigestBook,
): string {
  const lines: string[] = [];

  lines.push(`# ${book.title}`);
  lines.push("");
  lines.push("## Metadata");
  lines.push(`- Author: [[${book.author}]]`);
  lines.push(`- Full Title: ${book.title}`);
  lines.push(`- Year: ${book.year}`);
  lines.push(`- Category: ${book.category}`);
  lines.push("");
  lines.push("## Highlights");

  for (const h of book.highlights) {
    const loc = h.chapter
      ? `Page ${h.page}, Chapter ${h.chapter}`
      : `Page ${h.page}`;
    lines.push(`- ${h.content} (${loc})`);
  }

  return lines.join("\n") + "\n";
}
