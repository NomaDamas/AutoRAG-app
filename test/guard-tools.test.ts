import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { guardTools } from "../src/main/agents/guard-tools";
import { SECRET_PLACEHOLDER } from "../src/shared/secret-guard";

const leaky = (text: string) =>
	defineTool({
		name: "leaky",
		label: "Leaky",
		description: "returns text",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text }], details: { raw: text } }),
	});

describe("guardTools", () => {
	it("removes a known secret and a credential-looking value from every text result, and from details", async () => {
		const known = new Set(["hunter2-hunter2-hunter2"]);
		const [tool] = guardTools([leaky("value hunter2-hunter2-hunter2 and sk-ant-api03-AbCdEf0123456789_AbCdEf0123456789 end")], known);
		const result = await tool!.execute("c", {}, undefined, undefined, undefined as never);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).not.toContain("hunter2");
		expect(text).not.toContain("sk-ant");
		expect(text).toContain(SECRET_PLACEHOLDER);
		expect(JSON.stringify(result.details)).not.toContain("hunter2");
	});

	it("sees a secret added to the set after the tools were wrapped", async () => {
		const known = new Set<string>();
		const [tool] = guardTools([leaky("late-secret-value-123")], known);
		known.add("late-secret-value-123");
		const result = await tool!.execute("c", {}, undefined, undefined, undefined as never);
		expect(result.content[0]).toMatchObject({ text: SECRET_PLACEHOLDER });
	});

	it("keeps name, schema and ordinary output untouched", async () => {
		const [tool] = guardTools([leaky("plain /Users/me/Documents text")], new Set());
		expect(tool!.name).toBe("leaky");
		const result = await tool!.execute("c", {}, undefined, undefined, undefined as never);
		expect(result.content[0]).toMatchObject({ text: "plain /Users/me/Documents text" });
	});
});
