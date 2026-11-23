import { describe, expect, it } from "vitest";
import { cellKind, chord, FLAGGED, formatClock, HIDDEN, newBoard, OPEN, reveal, toggleFlag, type Board } from "../src/renderer/src/first-run/minesweeper";

/** A deterministic generator (mulberry32), so a board is the same on every run. */
function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const minesOf = (board: Board): number[] => [...(board.mines ?? [])].flatMap((mine, index) => (mine === 1 ? [index] : []));

/** Open every safe cell, as a perfect player would. */
function solve(start: Board): Board {
	let board = start;
	for (const index of Array.from({ length: board.cells.length }, (_, i) => i)) {
		if ((board.mines as Uint8Array)[index] === 0) board = reveal(board, index);
	}
	return board;
}

describe("first reveal", () => {
	it("never hits a logo and opens a patch, whatever the seed", () => {
		for (let seed = 1; seed <= 200; seed += 1) {
			const board = reveal(newBoard(), 0, seeded(seed));
			expect(board.phase).toBe("playing");
			expect(board.opened).toBeGreaterThan(1);
			expect(minesOf(board)).toHaveLength(40);
		}
	});

	it("keeps the whole ring around a middle cell free", () => {
		const board = reveal(newBoard(), 8 * 16 + 8, seeded(7));
		for (const index of [119, 120, 121, 135, 136, 137, 151, 152, 153]) expect(board.mines?.[index]).toBe(0);
	});

	it("still places every logo on a board too full to keep the ring free", () => {
		const board = reveal(newBoard(4, 4, 7), 5, seeded(3));
		expect(minesOf(board)).toHaveLength(7);
		expect(board.mines?.[5]).toBe(0);
		expect(board.phase).not.toBe("lost");
	});

	it("rejects a board that cannot hold its logos", () => {
		expect(() => newBoard(3, 3, 1)).toThrow(RangeError);
	});
});

describe("counting and opening", () => {
	it("counts the logos around each open number", () => {
		const board = reveal(newBoard(), 0, seeded(11));
		for (let i = 0; i < board.cells.length; i += 1) {
			if (board.cells[i] !== OPEN) continue;
			const row = Math.floor(i / 16);
			const col = i % 16;
			let expected = 0;
			for (let dr = -1; dr <= 1; dr += 1) {
				for (let dc = -1; dc <= 1; dc += 1) {
					const r = row + dr;
					const c = col + dc;
					if ((dr !== 0 || dc !== 0) && r >= 0 && r < 16 && c >= 0 && c < 16) expected += board.mines?.[r * 16 + c] ?? 0;
				}
			}
			expect(board.near[i]).toBe(expected);
		}
	});

	it("opens a zero's whole region and the numbers bordering it, never a logo", () => {
		const board = reveal(newBoard(), 0, seeded(5));
		for (let i = 0; i < board.cells.length; i += 1) {
			if (board.cells[i] === OPEN) expect(board.mines?.[i]).toBe(0);
			if (board.cells[i] === OPEN && board.near[i] === 0) {
				for (const n of [i - 1, i + 1, i - 16, i + 16].filter((v) => v >= 0 && v < 256 && Math.abs((v % 16) - (i % 16)) <= 1)) {
					expect(board.cells[n]).toBe(OPEN);
				}
			}
		}
	});

	it("does not open a flagged cell", () => {
		const flagged = toggleFlag(newBoard(), 40);
		const board = reveal(flagged, 40, seeded(2));
		expect(board).toBe(flagged);
	});
});

describe("flags", () => {
	it("toggles, counts, and cannot be planted on an open cell", () => {
		let board = toggleFlag(newBoard(), 3);
		expect(board.cells[3]).toBe(FLAGGED);
		expect(board.flags).toBe(1);
		board = toggleFlag(board, 3);
		expect(board.cells[3]).toBe(HIDDEN);
		expect(board.flags).toBe(0);
		const started = reveal(newBoard(), 0, seeded(5));
		const open = started.cells.findIndex((cell) => cell === OPEN);
		expect(toggleFlag(started, open)).toBe(started);
	});
});

describe("losing", () => {
	it("opening a logo ends the game, marks the hit, and shows every other logo", () => {
		const started = reveal(newBoard(), 0, seeded(9));
		const [mine, other] = minesOf(started) as [number, number];
		const lost = reveal(started, mine);
		expect(lost.phase).toBe("lost");
		expect(cellKind(lost, mine)).toBe("boom");
		expect(cellKind(lost, other)).toBe("logo");
		expect(reveal(lost, 100)).toBe(lost);
		expect(toggleFlag(lost, 100)).toBe(lost);
	});

	it("keeps a right flag and exposes a wrong one", () => {
		const started = reveal(newBoard(), 0, seeded(9));
		const mines = minesOf(started);
		const wrong = started.cells.findIndex((cell, i) => cell === HIDDEN && started.mines?.[i] === 0);
		let board = toggleFlag(toggleFlag(started, mines[1] as number), wrong);
		board = reveal(board, mines[0] as number);
		expect(cellKind(board, mines[1] as number)).toBe("flag");
		expect(cellKind(board, wrong)).toBe("wrong");
	});
});

describe("winning", () => {
	it("wins when the last safe cell opens, with every logo shown as found", () => {
		const won = solve(reveal(newBoard(), 0, seeded(21)));
		expect(won.phase).toBe("won");
		expect(won.opened).toBe(256 - 40);
		expect(won.flags).toBe(40);
		for (const index of minesOf(won)) expect(cellKind(won, index)).toBe("found");
	});

	it("does not win by flagging alone", () => {
		let board = reveal(newBoard(), 0, seeded(21));
		for (const index of minesOf(board)) board = toggleFlag(board, index);
		expect(board.phase).toBe("playing");
	});
});

describe("chording", () => {
	it("opens the other neighbours when the flags match the number", () => {
		const started = reveal(newBoard(), 0, seeded(13));
		const number = started.cells.findIndex((cell, i) => cell === OPEN && started.near[i] === 1);
		const neighbours = [-17, -16, -15, -1, 1, 15, 16, 17]
			.map((d) => number + d)
			.filter((n) => n >= 0 && n < 256 && Math.abs((n % 16) - (number % 16)) <= 1);
		const mine = neighbours.find((n) => started.mines?.[n] === 1) as number;
		const after = chord(toggleFlag(started, mine), number);
		expect(after.opened).toBeGreaterThanOrEqual(started.opened);
		for (const n of neighbours) if (n !== mine) expect(after.cells[n]).toBe(OPEN);
	});

	it("does nothing with too few flags, and loses on a wrong flag", () => {
		const started = reveal(newBoard(), 0, seeded(13));
		const number = started.cells.findIndex((cell, i) => cell === OPEN && started.near[i] === 1);
		expect(chord(started, number)).toBe(started);
		const neighbours = [-17, -16, -15, -1, 1, 15, 16, 17]
			.map((d) => number + d)
			.filter((n) => n >= 0 && n < 256 && Math.abs((n % 16) - (number % 16)) <= 1 && started.cells[n] === HIDDEN);
		const safe = neighbours.find((n) => started.mines?.[n] === 0) as number;
		expect(chord(toggleFlag(started, safe), number).phase).toBe("lost");
	});
});

describe("formatClock", () => {
	it("shows tenths under a minute and minutes after", () => {
		expect(formatClock(0)).toBe("0.0");
		expect(formatClock(12_340)).toBe("12.3");
		expect(formatClock(65_400)).toBe("1:05.4");
		expect(formatClock(-5)).toBe("0.0");
	});
});
