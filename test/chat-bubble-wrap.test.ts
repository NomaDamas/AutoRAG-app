import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const components = join(__dirname, "..", "src", "renderer", "src", "components");
const read = (file: string): string => readFileSync(join(components, file), "utf8");

/** The `className` strings of every chat bubble: the dark question, a correction, and a queued question. */
function bubbleClasses(source: string): string[] {
	return [...source.matchAll(/"([^"]*(?:inspector-chat-question|\bbubble\b|queued-bubble)[^"]*)"/g)].map((match) => match[1] ?? "");
}

// A bubble is a flex item in a column with `items-end`. `overflow-wrap: break-word` (Tailwind's `break-words`) does not
// lower the item's min-content width, so a question that holds one long unbroken word (a URL) made the bubble as wide as
// that word and it ran out past the left edge of the sidebar chat, over the file list. `overflow-wrap: anywhere` does
// lower it, so the bubble wraps inside its column.
describe("chat bubbles wrap a long unbroken word inside their column", () => {
	for (const file of ["InspectorChat.tsx", "AiSearchPanel.tsx", "FollowUpBubbles.tsx"]) {
		it(`${file} draws every bubble with overflow-wrap: anywhere`, () => {
			const classes = bubbleClasses(read(file)).filter((value) => value.includes("rounded-[16px]"));
			expect(classes.length).toBeGreaterThan(0);
			for (const value of classes) {
				expect(value, value).toContain("[overflow-wrap:anywhere]");
				expect(value, value).not.toContain("break-words");
				expect(value, value).toContain("min-w-0");
			}
		});
	}
});
