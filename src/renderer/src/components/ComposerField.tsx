/**
 * The AI Search message field: a wrapping textarea that grows with the draft up
 * to `COMPOSER_MAX_ROWS` rows, then scrolls inside itself, so a long question is
 * always readable in the composer instead of running off one line.
 *
 * Enter sends (through the enclosing form, so the panel's own submit guard
 * applies), Shift+Enter inserts a newline, Alt+Enter queues. Enter that confirms
 * an IME composition is never a send.
 */

import { useLayoutEffect, useRef, type KeyboardEvent, type ReactElement, type Ref } from "react";
import { cn } from "../lib/cn";

/** Rows the field grows to before it starts scrolling. */
export const COMPOSER_MAX_ROWS = 8;

const FALLBACK_LINE_HEIGHT_RATIO = 1.5;

export interface ComposerFit {
	readonly height: number;
	readonly scrolls: boolean;
}

/** The field's pixel height for its wrapped content: one row minimum, `maxRows` maximum. */
export function composerFit({
	contentHeight,
	rowHeight,
	maxRows,
}: {
	readonly contentHeight: number;
	readonly rowHeight: number;
	readonly maxRows: number;
}): ComposerFit {
	const max = rowHeight * maxRows;
	return { height: Math.min(Math.max(contentHeight, rowHeight), max), scrolls: contentHeight > max };
}

function rowHeightOf(field: HTMLTextAreaElement): number {
	const style = window.getComputedStyle(field);
	const lineHeight = Number.parseFloat(style.lineHeight);
	if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
	const fontSize = Number.parseFloat(style.fontSize);
	return (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14) * FALLBACK_LINE_HEIGHT_RATIO;
}

/** Measure the wrapped content at the current width and size the field to it. */
function fit(field: HTMLTextAreaElement): void {
	field.style.height = "auto";
	const { height, scrolls } = composerFit({
		contentHeight: field.scrollHeight,
		rowHeight: rowHeightOf(field),
		maxRows: COMPOSER_MAX_ROWS,
	});
	field.style.height = `${height}px`;
	field.style.overflowY = scrolls ? "auto" : "hidden";
}

export interface ComposerFieldProps {
	readonly value: string;
	readonly onChange: (value: string) => void;
	/** Alt+Enter: queue the draft as the next question. */
	readonly onAltEnter: () => void;
	readonly placeholder: string;
	readonly ariaLabel: string;
	readonly fieldRef?: Ref<HTMLTextAreaElement>;
}

export function ComposerField({ value, onChange, onAltEnter, placeholder, ariaLabel, fieldRef }: ComposerFieldProps): ReactElement {
	const localRef = useRef<HTMLTextAreaElement | null>(null);

	useLayoutEffect(() => {
		if (localRef.current !== null) fit(localRef.current);
	}, [value]);

	// Wrapping depends on the width: refit when the panel is resized.
	useLayoutEffect(() => {
		const field = localRef.current;
		if (field === null || typeof ResizeObserver === "undefined") return;
		let width = field.clientWidth;
		const observer = new ResizeObserver(() => {
			if (field.clientWidth === width) return;
			width = field.clientWidth;
			fit(field);
		});
		observer.observe(field);
		return () => observer.disconnect();
	}, []);

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (event.key !== "Enter" || event.shiftKey) return;
		// A Hangul/Japanese/Chinese IME's confirming Enter is no send (keyCode 229 covers Safari's late flag).
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		if (event.altKey) {
			onAltEnter();
			return;
		}
		event.currentTarget.form?.requestSubmit();
	}

	return (
		<textarea
			ref={(node) => {
				localRef.current = node;
				if (typeof fieldRef === "function") fieldRef(node);
				else if (fieldRef) fieldRef.current = node;
			}}
			rows={1}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			onKeyDown={onKeyDown}
			placeholder={placeholder}
			aria-label={ariaLabel}
			className={cn(
				"composer-field block w-full min-w-0 resize-none border-0 bg-transparent p-0 text-body leading-body text-ink-body outline-none [overflow-wrap:anywhere] placeholder:text-ink-muted",
			)}
		/>
	);
}
