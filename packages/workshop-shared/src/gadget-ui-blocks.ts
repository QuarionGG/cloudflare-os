// `<gadget-ui>` blocks in an agent's answer: live views the Workshop draws in place of the block's
// text (see plans/live-views.md). This module is the one parser of the syntax. The Workshop
// lays out a message with it, and the kernel writes the text a chat gateway gets with it.

/** One closed `<gadget-ui>` block of an agent answer. */
export type GadgetUiBlock = {
  kind: "block";

  /** The block's HTML: everything between its tags, trimmed. */
  html: string;

  /** The text of the block's `<title>` element, if it has one. */
  title?: string;

  /** Why the block must not run: it has nothing but a title. */
  error?: string;
};

/** One part of an agent answer, in order: prose, a closed block, or a block still open. */
export type GadgetUiSegment =
  /** Prose. `start` is its offset in the answer, for positions such as `CapsuleSpecifier`'s. */
  | { kind: "text"; text: string; start: number }
  | GadgetUiBlock
  /**
   * An opening tag with no closing tag after it: the answer is still streaming, or the agent never
   * closed the block. `text` runs from the tag to the end of the answer. `html` is the block's
   * HTML so far, which is always the start of its `html` once it closes.
   */
  | { kind: "open"; text: string; html: string; title?: string };

const CLOSE = "</gadget-ui>";

// A tag counts only where it opens a line outside a code fence, so prose and examples that
// mention the tag stay prose.
const OPEN = /^[ \t]*<gadget-ui\b[^>]*>/;

// Any line that may open a fence opens one: reading too much as code only keeps a block from
// being drawn. A fence may follow list item and block quote markers on its line. Each marker ends
// its own run of spaces, so the pattern reads a line one way only.
const FENCE_OPEN = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]*)*(`{3,}(?=[^`]*$)|~{3,})/;

// One list item or block quote marker before a fence, from the end of the marker before it.
const CONTAINER = /[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+)/y;
const QUOTE = /^[ \t]{0,3}>[ \t]?/;

// Only a closing fence closes one: a marker alone on its line, indented at most three spaces
// inside the containers the fence opened in, however deep the line that opened it.
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

// A list item's `width` is its content column, counted from the end of the container before it.
type Container = { kind: "quote" } | { kind: "item"; width: number };
// A fence on a line of its own has no containers of its own; it takes the list item still open
// from earlier lines, if any. The block quote it may sit in is unknown.
type Fence = { marker: string; containers: Container[] };

// A line that opens a list item, up to the item's content.
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;

// The columns `text` takes when it starts at column `from`: a tab runs to the next multiple of four.
function columns(text: string, from = 0): number {
  let column = from;
  for (let char of text) column += char === "\t" ? 4 - column % 4 : 1;
  return column - from;
}
const indentOf = (line: string, from = 0) => columns(line.slice(0, line.search(/\S|$/)), from);

/** The content column of the list item open after `line`, given the one open before it. */
function itemAfter(item: number | undefined, line: string): number | undefined {
  let marker = LIST_ITEM.exec(line)?.[0];
  if (marker !== undefined) return columns(marker) + (/[ \t]$/.test(marker) ? 0 : 1);
  if (line.trim() === "") return item;
  return item !== undefined && indentOf(line) >= item ? item : undefined;
}

/** The fence `line` opens, or null when it opens none, given the list item open before it. */
function fenceOpenedBy(line: string, item: number | undefined): Fence | null {
  let open = FENCE_OPEN.exec(line);
  if (open === null) return null;
  let marker = open[1];
  let prefix = open[0].slice(0, -marker.length);
  let containers: Container[] = [];
  CONTAINER.lastIndex = 0;
  let column = 0;
  for (let token = CONTAINER.exec(prefix); token !== null; token = CONTAINER.exec(prefix)) {
    let width = columns(token[0], column);
    containers.push(token[0].includes(">") ? {kind: "quote"} : {kind: "item", width});
    column += width;
  }
  if (containers.length === 0 && item !== undefined && columns(prefix) >= item) {
    return {marker, containers: [{kind: "item", width: item}]};
  }
  return {marker, containers};
}

// What `line` does to the open `fence`: closes it, leaves it open, or ends a container the fence
// is in, which ends the fence and leaves the line to be read again outside it.
function lineInFence(fence: Fence, line: string): "closes" | "stays" | "ends" {
  let rest = line;
  let column = 0;
  for (let container of fence.containers) {
    if (container.kind === "quote") {
      let quote = QUOTE.exec(rest);
      if (quote === null) return "ends";
      column += columns(quote[0], column);
      rest = rest.slice(quote[0].length);
    } else if (rest.trim() === "") {
      rest = "";
    } else {
      let indent = indentOf(rest, column);
      if (indent < container.width) return "ends";
      rest = " ".repeat(indent - container.width) + rest.trimStart();
      column += container.width;
    }
  }
  let marker = FENCE_CLOSE.exec(rest)?.[1];
  let closes = marker !== undefined && marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length && indentOf(rest, column) <= 3;
  return closes ? "closes" : "stays";
}

// The first <title> element of `html`: its text as HTML reads it, with runs of whitespace as one
// space, and the HTML around it. Two plain searches, because a lazy pattern rescans the rest of the
// HTML from every <title> that never closes, and the Workshop parses on every streamed delta.
function splitTitle(html: string): {title: string | undefined; rest: string} {
  let open = html.search(/<title>/i);
  let textStart = open + "<title>".length;
  let textLength = open === -1 ? -1 : html.slice(textStart).search(/<\/title>/i);
  if (textLength === -1) return {title: undefined, rest: html};
  let textEnd = textStart + textLength;
  let title = html.slice(textStart, textEnd).replace(/\s+/g, " ").trim();
  return {
    title: title === "" ? undefined : title,
    rest: html.slice(0, open) + html.slice(textEnd + "</title>".length),
  };
}

/**
 * Whether a view's HTML has no content: nothing but whitespace once its `<title>` is taken out.
 * Such a block shows an error, and the kernel refuses such a view from `embedView` unless a script
 * draws it.
 */
export function isEmptyViewHtml(html: string): boolean {
  return splitTitle(html).rest.trim() === "";
}

function closedBlock(html: string): GadgetUiBlock {
  let block: GadgetUiBlock = {kind: "block", html};
  let {title} = splitTitle(html);
  if (title !== undefined) block.title = title;
  if (isEmptyViewHtml(html)) block.error = "This view has no content.";
  return block;
}

// An open block's HTML so far: its body, trimmed as a closed block's is, without a closing tag
// that has only partly arrived. Any part of a closing tag starts at its only "<".
function openHtml(body: string): string {
  let tag = body.lastIndexOf("<");
  return (tag !== -1 && CLOSE.startsWith(body.slice(tag)) ? body.slice(0, tag) : body).trim();
}

const LINE_END = /[\r\n]/g;

/** Splits an agent answer into prose and `<gadget-ui>` blocks, in order. */
export function parseGadgetUiBlocks(text: string): GadgetUiSegment[] {
  let segments: GadgetUiSegment[] = [];
  let prose = 0;
  let line = 0;
  let fence: Fence | null = null;
  // The content column of the list item open outside a fence, if any.
  let item: number | undefined;

  // A line ends at "\n", "\r\n" or a lone "\r", as Markdown reads it.
  let lineEndAt = (start: number) => {
    LINE_END.lastIndex = start;
    return LINE_END.exec(text) === null ? text.length : LINE_END.lastIndex - 1;
  };
  let nextLineAt = (lineEnd: number) => lineEnd + (text.startsWith("\r\n", lineEnd) ? 2 : 1);

  while (line < text.length) {
    let lineEnd = lineEndAt(line);
    let lineText = text.slice(line, lineEnd);
    if (fence !== null) {
      let effect = lineInFence(fence, lineText);
      if (effect !== "ends") line = nextLineAt(lineEnd);
      else item = undefined;
      if (effect !== "stays") fence = null;
      continue;
    }
    let open = OPEN.exec(lineText);
    if (open === null) {
      item = itemAfter(item, lineText);
      fence = fenceOpenedBy(lineText, item);
      line = nextLineAt(lineEnd);
      continue;
    }

    if (prose < line) segments.push({kind: "text", text: text.slice(prose, line), start: prose});
    let body = line + open[0].length;
    let close = text.indexOf(CLOSE, body);
    if (close === -1) {
      let rest = text.slice(line);
      let {title} = splitTitle(rest);
      let html = openHtml(text.slice(body));
      segments.push(title === undefined ? {kind: "open", text: rest, html} : {kind: "open", text: rest, html, title});
      return segments;
    }

    segments.push(closedBlock(text.slice(body, close).trim()));
    prose = close + CLOSE.length;
    line = nextLineAt(lineEndAt(prose));
    // The Workshop renders the prose after a view as a Markdown document of its own.
    item = undefined;
  }

  if (prose < text.length) segments.push({kind: "text", text: text.slice(prose), start: prose});
  return segments;
}

/**
 * An agent answer for a reader that shows only text, such as a chat gateway: each closed
 * `<gadget-ui>` block becomes a note that names it. An unclosed block stays as written, as the
 * chat shows it.
 */
export function gadgetUiAnswerAsText(text: string): string {
  return parseGadgetUiBlocks(text).map(segment => segment.kind !== "block" ? segment.text
      : segment.title === undefined ? "[View in the chat]" : `[View in the chat: ${segment.title}]`)
      .join("");
}
