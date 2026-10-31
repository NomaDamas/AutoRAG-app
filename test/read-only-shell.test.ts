import { describe, expect, it } from "vitest";
import { analyzeShellCommand } from "../src/main/read-only-shell";

describe("analyzeShellCommand: commands that only read", () => {
	it.each([
		"ls -la",
		"pwd",
		'cat "C:\\Users\\me\\Documents\\meeting-2026-10-01.md"',
		"wc -c < log",
		'grep -rn "예산" . | head -20',
		'find . -name "*.docx" -type f',
		"sed -n '1,40p' notes.md",
		"git status",
		"git log --oneline -5",
		"git -C /tmp/repo diff",
		"cat a.txt 2>/dev/null",
		"ls missing 2>&1 | head",
		"cat a.txt >/dev/null",
		'echo "hello"',
		"tar -tf archive.tar",
		"tar tzf archive.tgz",
		"unzip -l archive.zip",
		"unzip -p report.docx word/document.xml",
		"7z l archive.7z",
		"pdftotext report.pdf -",
		"sort -u names.txt",
		"sort -t , -k 2 data.csv",
		"cat a.txt\nls\nhead -3 b.txt",
		"cd /c/Users/me/QA-Docs && ls -la",
		"ls \\\n  -la",
		'for f in *.md; do echo "$f"; head -3 "$f"; done',
		'for f in a.docx b.docx; do unzip -p "$f" word/document.xml | sed -e \'s/<[^>]*>/ /g\' -e \'s/&amp;/\\&/g\' | head -c 2000; echo; done',
		"/usr/bin/cat notes.md",
		"cat notes.md | jq .",
	])("%s", (command) => {
		expect(analyzeShellCommand(command).readOnly).toBe(true);
	});

	it("accepts the command from the issue: unzip a docx and strip its markup, in a loop after cd", () => {
		const command =
			"cd /c/Users/me/QA-Docs && for f in contracts/proposal-final.docx contracts/old.docx; do echo \"== $f\"; unzip -p \"$f\" word/document.xml | sed -e 's/<[^>]*>/ /g' | tr -s ' ' | head -c 3000; echo; done";
		expect(analyzeShellCommand(command)).toEqual({ readOnly: true });
	});
});

describe("analyzeShellCommand: commands that may change something", () => {
	it.each([
		"rm -rf build",
		"mv a b",
		"cp a b",
		"touch x",
		"mkdir out",
		"cat a.txt > b.txt",
		"cat a.txt >> b.txt",
		"echo hi > notes.md",
		"ls > listing.txt",
		"cat a.txt 2> errors.log",
		"cat a.txt &> all.log",
		"cat a | tee b.txt",
		"sed -i 's/a/b/' f.txt",
		"sed -i.bak 's/a/b/' f.txt",
		"sed -ni 's/a/b/p' f.txt",
		"sed --in-place 's/a/b/' f.txt",
		"sed 's/a/b/w out.txt' f.txt",
		"sed -e '1e rm x' f.txt",
		"sed -f script.sed f.txt",
		"sed 'w out.txt' f.txt",
		"find . -delete",
		"find . -name '*.tmp' -exec rm {} \\;",
		"find . -fprint out.txt",
		"unzip archive.zip",
		"unzip -o archive.zip -d out",
		"tar -xf archive.tar",
		"tar -czf out.tgz dir",
		"7z x archive.7z",
		"cat a; rm b",
		"ls && rm b",
		"ls || rm b",
		"ls | xargs rm",
		"ls &",
		"cat $(rm x)",
		"cat `rm x`",
		'echo "$(date)"',
		"cat <(rm x)",
		"cat <<EOF\nhello\nEOF",
		"curl https://example.com",
		'python -c "print(1)"',
		"bash script.sh",
		"eval ls",
		"FOO=bar ls",
		"sort -o out.txt in.txt",
		"sort --compress-program=evil in.txt",
		"git checkout .",
		"git commit -m x",
		"git log --output=out.txt",
		"rg --pre ./evil foo",
		"date -s 2020-01-01",
		"pdftotext report.pdf out.txt",
		"./cat notes.md",
		"/tmp/cat notes.md",
		"awk '{print > \"x\"}' f",
		"ls # a comment",
		"(cd x && ls)",
		"{ ls; }",
		"while read x; do rm $x; done < list",
		"if true; then rm x; fi",
		"for f in a b; do rm $f; done",
		"$CMD file",
		'cat "unterminated',
		"cat a.txt [...12 characters omitted...] b.txt",
		"cat [unbroken text of 1200 characters omitted]",
		"",
		"   ",
		"cat a.txt >& out.txt",
		"cat a.txt >| out.txt",
		"cat <> a.txt",
		"constructor x",
		"toString",
		"__proto__ x",
	])("%j", (command) => {
		expect(analyzeShellCommand(command).readOnly).toBe(false);
	});

	it("names why a command was not recognised, for the log", () => {
		const verdict = analyzeShellCommand("rm -rf build");
		expect(verdict.readOnly).toBe(false);
		if (!verdict.readOnly) expect(verdict.why).toContain("rm");
	});
});
