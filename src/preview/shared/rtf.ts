export function rtfToText(source: string): string {
	let out = "";
	let index = 0;
	while (index < source.length) {
		const char = source[index] ?? "";
		if (char === "{" || char === "}") {
			index += 1;
			continue;
		}
		if (char !== "\\") {
			out += char;
			index += 1;
			continue;
		}
		const next = source[index + 1] ?? "";
		if (next === "\\" || next === "{" || next === "}") {
			out += next;
			index += 2;
			continue;
		}
		if (next === "'") {
			const hex = source.slice(index + 2, index + 4);
			if (/^[0-9a-fA-F]{2}$/.test(hex)) {
				out += String.fromCharCode(Number.parseInt(hex, 16));
				index += 4;
				continue;
			}
		}
		index += 1;
		let word = "";
		while (index < source.length) {
			const letter = source[index] ?? "";
			if ((letter >= "a" && letter <= "z") || (letter >= "A" && letter <= "Z")) {
				word += letter;
				index += 1;
				continue;
			}
			break;
		}
		if (source[index] === "-") index += 1;
		while ((source[index] ?? "") >= "0" && (source[index] ?? "") <= "9") index += 1;
		if (source[index] === " ") index += 1;
		if (word === "par" || word === "line") out += "\n";
		if (word === "tab") out += "\t";
	}
	return out.replace(/\n{3,}/g, "\n\n").trim();
}
