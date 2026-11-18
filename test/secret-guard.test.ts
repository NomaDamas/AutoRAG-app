import { describe, expect, it } from "vitest";
import { findSecrets, maskSecret, redactSecrets, SECRET_PLACEHOLDER } from "../src/shared/secret-guard";

describe("maskSecret", () => {
	it("shows only the last four characters of a long secret and never the rest", () => {
		const masked = maskSecret("sk-proj-abcdefghijklmnop1234");
		expect(masked.endsWith("1234")).toBe(true);
		expect(masked).not.toContain("abcdefghijklmnop");
	});
	it("hides a short value entirely", () => {
		expect(maskSecret("abc123")).not.toContain("abc");
	});
});

describe("findSecrets / redactSecrets", () => {
	const cases: ReadonlyArray<readonly [string, string]> = [
		["OpenAI key", "my key is sk-proj-AbCdEf0123456789AbCdEf0123 ok"],
		["Anthropic key", "sk-ant-api03-AbCdEf0123456789_AbCdEf0123456789"],
		["GitHub token", "token ghp_AbCdEf0123456789AbCdEf0123456789abcd"],
		["fine-grained GitHub token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
		["Google key", "AIzaSyA-0123456789abcdefghijklmnopqrstuv"],
		["Slack token", "xoxb-1234567890-abcdefghijkl"],
		["Bearer header", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
		["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz"],
		["private key block", "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkq\n-----END PRIVATE KEY-----"],
		["assignment", 'api_key = "Zx9fQ2LmP8vTn4Rk7Wa3"'],
		["json assignment", '{"apiKey": "Zx9fQ2LmP8vTn4Rk7Wa3"}'],
	];
	for (const [label, text] of cases) {
		it(`finds and removes ${label}`, () => {
			expect(findSecrets(text)).toBeGreaterThan(0);
			const clean = redactSecrets(text);
			expect(clean).toContain(SECRET_PLACEHOLDER);
			expect(findSecrets(clean)).toBe(0);
		});
	}

	it("leaves ordinary text, paths, hashes and urls alone", () => {
		const text = "Add /Users/me/Documents/report-2026.pdf and https://example.com/mcp?x=1, commit 3a5d15016aab523c018a9e55c2382c3e909bc9be, port 47833";
		expect(findSecrets(text)).toBe(0);
		expect(redactSecrets(text)).toBe(text);
	});

	it("also removes exact secret values it was told about, wherever they appear", () => {
		const secret = "correct-horse-battery-staple-9981";
		const out = redactSecrets(`env says ${secret} and again ${secret}.`, [secret]);
		expect(out).not.toContain(secret);
		expect(out.split(SECRET_PLACEHOLDER).length - 1).toBe(2);
	});

	it("ignores known values too short to be a secret instead of mangling the text", () => {
		expect(redactSecrets("a b c abc", ["a", "abc"])).toBe("a b c abc");
	});
});
