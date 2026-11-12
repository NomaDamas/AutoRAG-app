/**
 * The rules of the setup-screen game (DESIGN.md §3a): classic Minesweeper, with
 * the Dazzi logo hiding where the mines would be. Pure and framework-free; the
 * board is replaced, never mutated, so React can compare by identity.
 */

export const GAME_ROWS = 16;
export const GAME_COLS = 16;
export const GAME_MINES = 40;

/** What the player has done to a cell. A mine is only ever shown by the phase, never stored here. */
export const HIDDEN = 0;
export const OPEN = 1;
export const FLAGGED = 2;

export type Phase = "ready" | "playing" | "won" | "lost";

export interface Board {
	readonly rows: number;
	readonly cols: number;
	readonly mineCount: number;
	/** 1 where a logo hides. Null until the first reveal, which decides where they go. */
	readonly mines: Uint8Array | null;
	/** Logos among the eight neighbours; meaningful once `mines` exists. */
	readonly near: Uint8Array;
	readonly cells: Uint8Array;
	readonly phase: Phase;
	readonly opened: number;
	readonly flags: number;
	/** The cell that ended a lost game, or -1. */
	readonly hit: number;
}

export function newBoard(rows = GAME_ROWS, cols = GAME_COLS, mineCount = GAME_MINES): Board {
	const size = rows * cols;
	if (mineCount < 1 || mineCount > size - 9) throw new RangeError(`a ${rows}x${cols} board cannot hold ${mineCount} logos`);
	return { rows, cols, mineCount, mines: null, near: new Uint8Array(size), cells: new Uint8Array(size), phase: "ready", opened: 0, flags: 0, hit: -1 };
}

/** Calls `visit` with each in-bounds neighbour of `index`. */
function eachNeighbour(rows: number, cols: number, index: number, visit: (neighbour: number) => void): void {
	const row = Math.floor(index / cols);
	const col = index % cols;
	for (let dr = -1; dr <= 1; dr += 1) {
		for (let dc = -1; dc <= 1; dc += 1) {
			if (dr === 0 && dc === 0) continue;
			const r = row + dr;
			const c = col + dc;
			if (r >= 0 && r < rows && c >= 0 && c < cols) visit(r * cols + c);
		}
	}
}

/** Scatter the logos so the first cell, and the ring around it, is free: the first click always opens a patch. */
function placeMines(board: Board, safe: number, rng: () => number): { mines: Uint8Array; near: Uint8Array } {
	const size = board.rows * board.cols;
	const protectedCells = new Set<number>([safe]);
	eachNeighbour(board.rows, board.cols, safe, (n) => protectedCells.add(n));
	// The ring is only protected while the board has room for every logo outside it.
	const keepRing = size - protectedCells.size >= board.mineCount;
	const candidates: number[] = [];
	for (let i = 0; i < size; i += 1) if (i !== safe && (!keepRing || !protectedCells.has(i))) candidates.push(i);
	const mines = new Uint8Array(size);
	for (let placed = 0; placed < board.mineCount; placed += 1) {
		const pick = placed + Math.floor(rng() * (candidates.length - placed));
		const chosen = candidates[pick] as number;
		candidates[pick] = candidates[placed] as number;
		candidates[placed] = chosen;
		mines[chosen] = 1;
	}
	const near = new Uint8Array(size);
	for (let i = 0; i < size; i += 1) {
		if (mines[i] === 1) continue;
		let count = 0;
		eachNeighbour(board.rows, board.cols, i, (n) => {
			count += mines[n] as number;
		});
		near[i] = count;
	}
	return { mines, near };
}

/** Open `start` and, when it touches no logo, everything the empty region reaches. */
function flood(rows: number, cols: number, mines: Uint8Array, near: Uint8Array, cells: Uint8Array, start: number): number {
	let opened = 0;
	const stack = [start];
	while (stack.length > 0) {
		const index = stack.pop() as number;
		if (cells[index] !== HIDDEN || mines[index] === 1) continue;
		cells[index] = OPEN;
		opened += 1;
		if (near[index] !== 0) continue;
		eachNeighbour(rows, cols, index, (n) => {
			if (cells[n] === HIDDEN) stack.push(n);
		});
	}
	return opened;
}

function settle(board: Board, cells: Uint8Array, opened: number, flags: number, hit: number): Board {
	const mines = board.mines as Uint8Array;
	if (hit >= 0) return { ...board, cells, opened, flags, hit, phase: "lost" };
	if (opened === board.rows * board.cols - board.mineCount) {
		// Every safe cell is open: the remaining logos are found, and shown flagged.
		for (let i = 0; i < cells.length; i += 1) if (mines[i] === 1) cells[i] = FLAGGED;
		return { ...board, cells, opened, flags: board.mineCount, hit: -1, phase: "won" };
	}
	return { ...board, cells, opened, flags, hit: -1, phase: "playing" };
}

/** Open one cell. The first call places the logos. Opening a logo ends the game. */
export function reveal(board: Board, index: number, rng: () => number = Math.random): Board {
	if (board.phase === "won" || board.phase === "lost") return board;
	if (board.cells[index] !== HIDDEN) return board;
	const placed = board.mines === null ? placeMines(board, index, rng) : { mines: board.mines, near: board.near };
	const started: Board = board.mines === null ? { ...board, ...placed } : board;
	const cells = started.cells.slice();
	if (placed.mines[index] === 1) return settle(started, cells, started.opened, started.flags, index);
	const opened = started.opened + flood(started.rows, started.cols, placed.mines, placed.near, cells, index);
	return settle(started, cells, opened, started.flags, -1);
}

/** Plant or lift a flag. Flags are free to place before the first reveal, as in the classic game. */
export function toggleFlag(board: Board, index: number): Board {
	if (board.phase === "won" || board.phase === "lost") return board;
	const current = board.cells[index];
	if (current === OPEN) return board;
	const cells = board.cells.slice();
	cells[index] = current === FLAGGED ? HIDDEN : FLAGGED;
	return { ...board, cells, flags: board.flags + (current === FLAGGED ? -1 : 1) };
}

/**
 * Click on an open number: when exactly that many flags surround it, open every
 * other neighbour at once. A wrong flag therefore loses, as it does everywhere.
 */
export function chord(board: Board, index: number): Board {
	if (board.phase !== "playing" || board.mines === null) return board;
	if (board.cells[index] !== OPEN || board.near[index] === 0) return board;
	let flagged = 0;
	const targets: number[] = [];
	eachNeighbour(board.rows, board.cols, index, (n) => {
		if (board.cells[n] === FLAGGED) flagged += 1;
		else if (board.cells[n] === HIDDEN) targets.push(n);
	});
	if (flagged !== board.near[index] || targets.length === 0) return board;
	const cells = board.cells.slice();
	let opened = board.opened;
	let hit = -1;
	for (const target of targets) {
		if (board.mines[target] === 1) {
			if (hit < 0) hit = target;
			continue;
		}
		opened += flood(board.rows, board.cols, board.mines, board.near, cells, target);
	}
	return settle(board, cells, opened, board.flags, hit);
}

/** How one cell is drawn. */
export type CellKind = "hidden" | "flag" | "open" | "logo" | "found" | "boom" | "wrong";

export function cellKind(board: Board, index: number): CellKind {
	const state = board.cells[index];
	const isMine = board.mines !== null && board.mines[index] === 1;
	if (board.phase === "lost") {
		if (index === board.hit) return "boom";
		if (isMine) return state === FLAGGED ? "flag" : "logo";
		return state === FLAGGED ? "wrong" : state === OPEN ? "open" : "hidden";
	}
	if (board.phase === "won" && isMine) return "found";
	return state === OPEN ? "open" : state === FLAGGED ? "flag" : "hidden";
}

/** `12.3` under a minute, `1:05.3` after; tenths only, so the display never jitters wider. */
export function formatClock(ms: number): string {
	const tenths = Math.max(0, Math.floor(ms / 100));
	const minutes = Math.floor(tenths / 600);
	const seconds = Math.floor((tenths % 600) / 10);
	const tenth = tenths % 10;
	return minutes === 0 ? `${seconds}.${tenth}` : `${minutes}:${String(seconds).padStart(2, "0")}.${tenth}`;
}
