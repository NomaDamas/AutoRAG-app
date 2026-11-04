/**
 * The game on the setup screen (DESIGN.md §3a): Minesweeper in which the Dazzi
 * logo hides where the mines would be. Left click opens, right click or
 * Shift+click plants a flag, clicking an open number with enough flags around it
 * opens the rest. The clock starts on the first open cell, and a finished board
 * is replaced by a fresh one on the next click so the player can go again faster.
 *
 * The rules live in `minesweeper.ts`; this file is the board, the clock, and the
 * session's best time (not stored: it is a waiting-room toy).
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactElement } from "react";
import { useTranslation } from "../../../shared/i18n";
import dazziLogo from "../assets/dazzi-logo.png";
import { FlagIcon } from "../components/icons";
import { chord, cellKind, formatClock, newBoard, OPEN, reveal, toggleFlag, type Board, type CellKind } from "./minesweeper";

/** A finished board ignores clicks this long, so the click that ended the game cannot also start the next. */
const RESTART_GUARD_MS = 600;
const CLOCK_TICK_MS = 100;

/** A finished board: won or lost. */
function isOver(board: Board): boolean {
	return board.phase === "won" || board.phase === "lost";
}

export function MineGame(): ReactElement {
	const { t } = useTranslation();
	const [board, setBoard] = useState<Board>(() => newBoard());
	const [round, setRound] = useState(0);
	const [elapsed, setElapsed] = useState(0);
	const [best, setBest] = useState<number | null>(null);
	const [record, setRecord] = useState(false);
	const boardRef = useRef(board);
	const bestRef = useRef<number | null>(null);
	const startedAt = useRef(0);
	const endedAt = useRef(0);

	/** Run one rule on the current board and do the clock's bookkeeping for the move. */
	const play = useCallback((step: (board: Board) => Board) => {
		const before = boardRef.current;
		const after = step(before);
		if (after === before) return;
		const now = performance.now();
		if (before.phase === "ready" && after.phase !== "ready") startedAt.current = now;
		if (!isOver(before) && isOver(after)) {
			endedAt.current = now;
			const ms = now - startedAt.current;
			setElapsed(ms);
			if (after.phase === "won") {
				const previous = bestRef.current;
				const beaten = previous === null || ms < previous;
				if (beaten) {
					bestRef.current = ms;
					setBest(ms);
				}
				setRecord(beaten && previous !== null);
			}
		}
		boardRef.current = after;
		setBoard(after);
	}, []);

	const restart = useCallback(() => {
		const fresh = newBoard();
		boardRef.current = fresh;
		setBoard(fresh);
		setRound((value) => value + 1);
		setElapsed(0);
		setRecord(false);
	}, []);

	useEffect(() => {
		if (board.phase !== "playing") return;
		const timer = window.setInterval(() => setElapsed(performance.now() - startedAt.current), CLOCK_TICK_MS);
		return () => window.clearInterval(timer);
	}, [board.phase]);

	const cellAt = (event: MouseEvent): number => {
		const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-i]") : null;
		return target === null ? -1 : Number(target.dataset.i);
	};

	const onClick = (event: MouseEvent): void => {
		const index = cellAt(event);
		if (index < 0) return;
		if (isOver(boardRef.current)) {
			if (performance.now() - endedAt.current < RESTART_GUARD_MS) return;
			restart();
			play((current) => reveal(current, index));
			return;
		}
		if (event.shiftKey) play((current) => toggleFlag(current, index));
		else if (boardRef.current.cells[index] === OPEN) play((current) => chord(current, index));
		else play((current) => reveal(current, index));
	};

	const onContextMenu = (event: MouseEvent): void => {
		event.preventDefault();
		const index = cellAt(event);
		if (index >= 0) play((current) => toggleFlag(current, index));
	};

	const onAuxClick = (event: MouseEvent): void => {
		if (event.button !== 1) return;
		event.preventDefault();
		const index = cellAt(event);
		if (index >= 0) play((current) => chord(current, index));
	};

	const cells: ReactElement[] = [];
	for (let index = 0; index < board.cells.length; index += 1) {
		const kind = cellKind(board, index);
		const row = Math.floor(index / board.cols);
		const col = index % board.cols;
		cells.push(
			<div
				key={index}
				className="fr-cell"
				data-i={index}
				data-kind={kind}
				data-n={kind === "open" && board.near[index] !== 0 ? board.near[index] : undefined}
				style={{ "--d": `${(row + col) * 14}ms` } as CSSProperties}
			>
				<CellFace kind={kind} near={board.near[index] as number} />
			</div>,
		);
	}

	const remaining = board.mineCount - board.flags;
	const over = isOver(board);
	return (
		<div className="fr-game" data-phase={board.phase}>
			<div className="fr-game-bar">
				<div className="fr-chip fr-chip--count" title={t("firstRun.game.remaining")}>
					<img className="fr-chip-logo" src={dazziLogo} alt="" draggable={false} />
					<span className="fr-chip-num" data-role="remaining">{remaining}</span>
				</div>
				<div className="fr-game-say" role="status" aria-live="polite">
					{board.phase === "won" ? (
						<>
							<strong>{record ? t("firstRun.game.record") : t("firstRun.game.won")}</strong>
							<button type="button" className="fr-btn fr-btn--primary fr-btn--sm" data-action="game-again" onClick={restart}>
								{t("firstRun.game.again")}
							</button>
						</>
					) : board.phase === "lost" ? (
						<>
							<strong>{t("firstRun.game.lost")}</strong>
							<button type="button" className="fr-btn fr-btn--secondary fr-btn--sm" data-action="game-again" onClick={restart}>
								{t("firstRun.game.again")}
							</button>
						</>
					) : (
						<span className="fr-game-hint">{t("firstRun.game.hint")}</span>
					)}
				</div>
				<div className="fr-chip fr-chip--time" title={t("firstRun.game.time")}>
					<span className="fr-chip-num" data-role="clock">{formatClock(elapsed)}</span>
					{best !== null ? <span className="fr-chip-best" data-role="best">{t("firstRun.game.best", { time: formatClock(best) })}</span> : null}
				</div>
			</div>
			<div
				key={round}
				className="fr-board"
				data-over={over ? board.phase : undefined}
				role="group"
				aria-label={t("firstRun.game.board")}
				style={{ "--cols": board.cols } as CSSProperties}
				onClick={onClick}
				onContextMenu={onContextMenu}
				onAuxClick={onAuxClick}
				onMouseDown={(event) => {
					if (event.button === 1) event.preventDefault();
				}}
			>
				{cells}
			</div>
		</div>
	);
}

function CellFace({ kind, near }: { readonly kind: CellKind; readonly near: number }): ReactElement | null {
	switch (kind) {
		case "flag":
		case "wrong":
			return <FlagIcon />;
		case "logo":
		case "found":
		case "boom":
			return <img className="fr-cell-logo" src={dazziLogo} alt="" draggable={false} />;
		case "open":
			return near > 0 ? <>{near}</> : null;
		default:
			return null;
	}
}
