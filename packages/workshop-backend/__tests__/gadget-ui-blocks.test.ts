import { describe, expect, it } from "vitest";
import { gadgetUiAnswerAsText, parseGadgetUiBlocks } from "@gadgets/workshop-shared/gadget-ui-blocks";

const lines = (...parts: string[]) => parts.join("\n");

describe("parseGadgetUiBlocks", () => {
  it("splits an answer into prose and blocks, in order, with each prose part's offset", () => {
    let answer = lines(
      "Food is up 18%.",
      "<gadget-ui>",
      "<title> Food, October </title>",
      "<div id=chart></div>",
      "</gadget-ui>",
      "Want weekly totals?",
    );
    expect(parseGadgetUiBlocks(answer)).toEqual([
      { kind: "text", text: "Food is up 18%.\n", start: 0 },
      { kind: "block", title: "Food, October",
        html: "<title> Food, October </title>\n<div id=chart></div>" },
      { kind: "text", text: "\nWant weekly totals?", start: answer.indexOf("\nWant") },
    ]);
  });

  it("refuses a block with nothing but a title, or nothing at all, whatever its attributes", () => {
    let segments = parseGadgetUiBlocks(lines(
      "<gadget-ui></gadget-ui>",
      "<gadget-ui>", "  <title>Plan</title>  ", "</gadget-ui>",
      "\t <gadget-ui class='wide'>", "<title>Plan</title><p>Step one</p>", "</gadget-ui>",
    ));
    expect(segments.flatMap(s => s.kind === "block" ? [[s.title, s.error]] : [])).toEqual([
      [undefined, "This view has no content."],
      ["Plan", "This view has no content."],
      ["Plan", undefined],
    ]);
  });

  it("parses a long block whose <title> never closes", () => {
    // Large enough that a pattern which rescans from each unclosed <title> exceeds the test timeout.
    let html = "<title>" + "<title>a".repeat(100_000);
    expect(parseGadgetUiBlocks(lines("<gadget-ui>", html, "</gadget-ui>")))
        .toEqual([{ kind: "block", html }]);
    expect(parseGadgetUiBlocks(lines("<gadget-ui>", html))).toEqual([
      { kind: "open", text: lines("<gadget-ui>", html), html },
    ]);
  });

  it("leaves a tag in a code fence or mid-line as prose", () => {
    let text = lines(
      "Write `<gadget-ui>` to draw a view:",
      "````html",
      "<gadget-ui>",
      "```",
      "</gadget-ui>",
      "````",
      "Done. <gadget-ui>not a block</gadget-ui>",
    );
    expect(parseGadgetUiBlocks(text)).toEqual([{ kind: "text", text, start: 0 }]);
  });

  it("closes a fence only on a bare marker of the same kind, at least as long", () => {
    let segments = parseGadgetUiBlocks(lines(
      "~~~~", "~~~", "```", "<gadget-ui>", "still code", "</gadget-ui>", "~~~~",
      "<gadget-ui>", "a view", "</gadget-ui>",
    ));
    expect(segments.map(s => s.kind)).toEqual(["text", "block"]);
  });

  it("closes a fence at most three spaces deeper than the content of the list item it is in", () => {
    let segments = parseGadgetUiBlocks(lines(
      "1. Start it:", "    ```sh", "    npm start", "    ```",
      "<gadget-ui>", "a view", "</gadget-ui>",
      "```", "        ```", "<gadget-ui>", "still code", "</gadget-ui>", "```",
    ));
    expect(segments.map(s => s.kind)).toEqual(["text", "block", "text"]);
  });

  it("closes a fence at three spaces of indent or less, however deep its opener is", () => {
    let views = (...parts: string[]) => parseGadgetUiBlocks(lines(...parts)).map(s => s.kind);
    let example = "<gadget-ui><script>agent.send(\"Example only\")</script></gadget-ui>";
    expect(views("  ```html", "  example", "    ```", example, "```")).toEqual(["text"]);
    expect(views("  ~~~html", "  example", "    ~~~", example, "~~~")).toEqual(["text"]);
    expect(views("  ```html", "  <gadget-ui>x</gadget-ui>", "   ```", "<gadget-ui>", "a view", "</gadget-ui>"))
      .toEqual(["text", "block"]);
  });

  it("reads a fence that follows a list or quote marker on its line as code, open or closed", () => {
    for (let marker of ["1. ", "- ", "* ", "2) ", "> ", "- > "]) {
      let pad = marker.replace(/[^>]/g, " ");
      let example = [`${marker}\`\`\`html`, `${pad}<gadget-ui>`, `${pad}<p>an example</p>`, `${pad}</gadget-ui>`];
      expect(parseGadgetUiBlocks(lines(...example)).map(s => s.kind), marker).toEqual(["text"]);
      expect(parseGadgetUiBlocks(lines(...example, `${pad}\`\`\``, "<gadget-ui>", "a view", "</gadget-ui>"))
          .map(s => s.kind), marker).toEqual(["text", "block"]);
    }
  });

  it("closes a quoted fence on a quoted closing fence, so a later fenced example stays code", () => {
    let text = lines(
      "> ```text", "> example", "> ```", "",
      "```", "<gadget-ui><p>Example only</p></gadget-ui>", "```",
    );
    expect(parseGadgetUiBlocks(text)).toEqual([{ kind: "text", text, start: 0 }]);
  });

  it("ends a fence where its block quote or list item ends, and reads that line outside it", () => {
    let views = (...parts: string[]) => parseGadgetUiBlocks(lines(...parts)).map(s => s.kind);
    expect(views(
      "> ```text", "> example", "Unquoted line.", "```", "<gadget-ui>", "<p>an example</p>", "</gadget-ui>", "```",
    )).toEqual(["text"]);
    expect(views("> ```html", "> example", "<gadget-ui>", "a view", "</gadget-ui>")).toEqual(["text", "block"]);
    expect(views("1. ```html", "   <p>x</p>", "```", "<gadget-ui>", "<p>an example</p>", "</gadget-ui>"))
      .toEqual(["text"]);
    expect(views("- ```html", "", "  <gadget-ui>", "  ```", "<gadget-ui>", "a view", "</gadget-ui>"))
      .toEqual(["text", "block"]);
    expect(views("> - ```html", ">   <gadget-ui>", ">   ```", "<gadget-ui>", "a view", "</gadget-ui>"))
      .toEqual(["text", "block"]);
  });

  it("keeps a fence in the list item it continues, so an outdented fence opens a new one", () => {
    let views = (...parts: string[]) => parseGadgetUiBlocks(lines(...parts)).map(s => s.kind);
    let example = ["```", "<gadget-ui><script>agent.send(\"Example only\")</script></gadget-ui>", "```"];
    expect(views("- Example:", "  ```text", "  example", ...example)).toEqual(["text"]);
    expect(views("1. Example:", "", "   ```text", "   example", ...example)).toEqual(["text"]);
    expect(views("- Example:", "  ```text", "  example", "<gadget-ui>", "a view", "</gadget-ui>"))
      .toEqual(["text", "block"]);
    expect(views("- Example:", "  ```text", "  <gadget-ui>x</gadget-ui>", "  ```", "<gadget-ui>", "a view", "</gadget-ui>"))
      .toEqual(["text", "block"]);
  });

  it("measures a tab to the next multiple of four columns", () => {
    let views = (...parts: string[]) => parseGadgetUiBlocks(lines(...parts)).map(s => s.kind);
    let view = ["<gadget-ui>", "a view", "</gadget-ui>"];
    expect(views("-\t```html", "\t<gadget-ui><p>Example only</p></gadget-ui>", "\t```")).toEqual(["text"]);
    expect(views("1.\t```html", "\t<gadget-ui>x</gadget-ui>", "\t```", ...view)).toEqual(["text", "block"]);
    expect(views("- ```", " \t<gadget-ui>x</gadget-ui>", "  ```", ...view)).toEqual(["text", "block"]);
  });

  it("reads \\r\\n and a lone \\r as line endings, with offsets into the original text", () => {
    let answer = ["Run it:", "```js", "start();", "```", "<gadget-ui>", "<p>a view</p>", "</gadget-ui>", "Done."].join("\r\n");
    let segments = parseGadgetUiBlocks(answer);
    expect(segments.map(s => s.kind)).toEqual(["text", "block", "text"]);
    for (let segment of segments) {
      if (segment.kind === "text") expect(answer.slice(segment.start, segment.start + segment.text.length)).toBe(segment.text);
    }
    let mixed = "```\r\nexample\r\n```\r\n\n```\n<gadget-ui><p>Example only</p></gadget-ui>\n```";
    expect(parseGadgetUiBlocks(mixed)).toEqual([{ kind: "text", text: mixed, start: 0 }]);
    expect(parseGadgetUiBlocks("```\rexample\r```\r<gadget-ui>\ra view\r</gadget-ui>").map(s => s.kind))
      .toEqual(["text", "block"]);
  });

  it("keeps an unclosed block open, with its HTML so far and its title once streamed", () => {
    let streamed = lines("Here it comes:", "<gadget-ui>", "<title>Plan</title>", "<div>");
    expect(parseGadgetUiBlocks(streamed)).toEqual([
      { kind: "text", text: "Here it comes:\n", start: 0 },
      { kind: "open", text: "<gadget-ui>\n<title>Plan</title>\n<div>", html: "<title>Plan</title>\n<div>", title: "Plan" },
    ]);
    expect(parseGadgetUiBlocks("<gadget-ui>\n<ti")).toEqual([{ kind: "open", text: "<gadget-ui>\n<ti", html: "<ti" }]);
  });

  it("keeps each block at its place among the segments at every cut of a streamed answer", () => {
    // The Workshop keeps a view by that place, from the moment its block opens, and writes an open
    // block's HTML into the view as it grows.
    let answer = lines(
      "Intro.", "<gadget-ui>", "<title>One</title>", "<p>1 < 2</p>", "</gadget-ui>",
      "<gadget-ui class='wide'>", "  <p>two</p>  ", "", "</gadget-ui>", "Outro.",
    );
    let final = parseGadgetUiBlocks(answer);
    let blocksAt = final.flatMap((segment, i) => segment.kind === "block" ? [i] : []);
    let opensAt = [...answer.matchAll(/^<gadget-ui[^>]*>/gm)].map(tag => tag.index + tag[0].length);
    for (let cut = 0; cut <= answer.length; cut++) {
      let parsed = parseGadgetUiBlocks(answer.slice(0, cut));
      expect(parsed.flatMap((segment, i) => segment.kind === "text" ? [] : [i]), `blocks at cut ${cut}`)
        .toEqual(blocksAt.filter((_, n) => opensAt[n] <= cut));
      parsed.forEach((segment, i) => {
        let block = final[i];
        if (segment.kind === "text" || block?.kind !== "block") return;
        if (segment.kind === "block") expect(segment).toEqual(block);
        else expect(block.html.slice(0, segment.html.length)).toBe(segment.html);
      });
    }
  });
});

describe("gadgetUiAnswerAsText", () => {
  it("puts a note that names each closed view in its place, and keeps an unclosed one", () => {
    let answer = lines(
      "Food is up 18%.", "<gadget-ui>", "<title>Food\n  by week</title>", "<script>draw()</script>",
      "</gadget-ui>", "<gadget-ui>", "<p>untitled</p>", "</gadget-ui>",
      "Want weekly totals?", "<gadget-ui>", "<div>",
    );
    expect(gadgetUiAnswerAsText(answer)).toBe(lines(
      "Food is up 18%.", "[View in the chat: Food by week]", "[View in the chat]",
      "Want weekly totals?", "<gadget-ui>", "<div>",
    ));
  });
});
