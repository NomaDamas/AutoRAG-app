import {
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type HTMLAttributes,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactElement,
	type ReactNode,
	type RefObject,
} from "react";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import dazziMarkMono from "../assets/dazzi-mark-mono.png";
import dazziMarkMonoDark from "../assets/dazzi-mark-mono-dark.png";
import { appendTranscript } from "../../../shared/voice-contract";
import { parseAnswerBlocks, parseInline, type InlineSegment } from "../state/answer-markdown";
import { VoiceButton } from "./InspectorChat";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { SeedLoader } from "./SeedLoader";

function renderInlineSegments(segments: readonly InlineSegment[]): ReactElement[] {
	return segments.map((seg, idx) => {
		switch (seg.kind) {
			case "bold":
				return <strong key={idx}>{seg.text}</strong>;
			case "code":
				return <code key={idx}>{seg.text}</code>;
			case "link":
				return <span key={idx}>{renderInlineSegments(seg.children)}</span>;
			case "citation":
				return <span key={idx}>[{seg.number}]</span>;
			case "file":
				return <span key={idx}>{seg.path}</span>;
			case "image":
				return <span key={idx}>{seg.target}</span>;
			default:
				return <span key={idx}>{seg.text}</span>;
		}
	});
}

/** Shared markdown reply renderer used across right-sidebar AI chats (Settings & Document Editor). */
export function SidebarReplyBody({ text }: { readonly text: string }): ReactElement {
	const blocks = parseAnswerBlocks(text);
	return (
		<div className="customizer-turn__reply">
			{blocks.map((block, idx) => {
				if (block.kind === "code") {
					return (
						<pre key={idx} className="m-0 overflow-x-auto rounded-6 bg-code p-8 font-mono text-badge">
							<code>{block.text}</code>
						</pre>
					);
				}
				if (block.kind === "table") {
					return <p key={idx}>{(block.header ?? []).join(" · ")}</p>;
				}
				if (block.kind === "list") {
					return (
						<div key={idx} className="customizer-turn__reply-item">
							<span className="customizer-turn__reply-bullet" aria-hidden="true">
								•
							</span>
							<span>{renderInlineSegments(parseInline(block.text))}</span>
						</div>
					);
				}
				if (block.kind === "heading") {
					return (
						<p key={idx} className="font-semibold">
							{renderInlineSegments(parseInline(block.text))}
						</p>
					);
				}
				return <p key={idx}>{renderInlineSegments(parseInline(block.text))}</p>;
			})}
		</div>
	);
}

/** Shared right-sidebar empty state matching Dazzi's faded monochrome Dazzi mark (Figma 367:8865). */
export function SidebarChatEmpty({
	title,
	description,
	rise = false,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly rise?: boolean;
	readonly children?: ReactNode;
}): ReactElement {
	const riseClass = rise ? " customizer-rise" : "";
	const riseStyle = rise ? ({ "--rise-i": 0 } as CSSProperties) : undefined;
	return (
		<div className="customizer-panel__empty">
			<div className={`customizer-panel__empty-orb${riseClass}`} style={riseStyle} aria-hidden="true">
				<img src={dazziMarkMono} alt="" className="customizer-panel__empty-logo customizer-panel__empty-logo--light" draggable={false} />
				<img src={dazziMarkMonoDark} alt="" className="customizer-panel__empty-logo customizer-panel__empty-logo--dark" draggable={false} />
			</div>
			<h3 className={`customizer-panel__empty-title${riseClass}`} style={riseStyle}>
				{title}
			</h3>
			<p className={`customizer-panel__empty-desc${riseClass}`} style={riseStyle}>
				{description}
			</p>
			{children}
		</div>
	);
}

/** Shared live-thinking shimmer row matching Finder Inspector & Settings right-sidebar chats. */
export function SidebarChatProgress({ text }: { readonly text: string }): ReactElement {
	return (
		<div className="customizer-turn__progress" role="status">
			<SeedLoader />
			<span className="shimmer min-w-0 truncate" title={text}>
				{text}
			</span>
		</div>
	);
}

export interface SidebarChatComposerProps {
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly onSend: () => void;
	readonly onStop: () => void;
	readonly onReset?: (() => void) | undefined;
	readonly showReset?: boolean | undefined;
	readonly running: boolean;
	readonly disabled?: boolean | undefined;
	readonly placeholder: string;
	readonly inputAriaLabel: string;
	readonly sendLabel: string;
	readonly stopLabel: string;
	readonly resetLabel?: string | undefined;
	readonly maxLength?: number | undefined;
	readonly textareaRef?: RefObject<HTMLTextAreaElement | null> | undefined;
	readonly inputTestId?: string | undefined;
	readonly sendAction?: string | undefined;
	readonly stopAction?: string | undefined;
	readonly resetAction?: string | undefined;
	/** Optional compact context row rendered inside the footer right above the composer card. */
	readonly above?: ReactNode;
	readonly hidden?: boolean | undefined;
}

/** Shared floating white composer bar used by right-sidebar AI chats (with VoiceButton, reset, and stop). */
export function SidebarChatComposer({
	value,
	onChange,
	onSend,
	onStop,
	onReset,
	showReset = false,
	running,
	disabled = false,
	placeholder,
	inputAriaLabel,
	sendLabel,
	stopLabel,
	resetLabel,
	maxLength,
	textareaRef: externalRef,
	inputTestId,
	sendAction,
	stopAction,
	resetAction,
	above,
	hidden = false,
}: SidebarChatComposerProps): ReactElement {
	const internalRef = useRef<HTMLTextAreaElement | null>(null);
	const textareaRef = externalRef ?? internalRef;
	const voice = window.autorag?.voice;

	useEffect(() => {
		const el = textareaRef.current;
		if (el === null) return;
		el.style.height = "auto";
		if (value.length > 0) {
			el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
			el.style.overflowY = el.scrollHeight > 96 ? "auto" : "hidden";
		} else {
			el.style.overflowY = "hidden";
		}
	}, [value, hidden, textareaRef]);

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			if (!running && !disabled && value.trim().length > 0) onSend();
		} else if (event.key === "Escape" && running) {
			event.preventDefault();
			onStop();
		}
	};

	return (
		<footer className="customizer-panel__foot">
			{above}
			<div className="customizer-composer">
				<textarea
					ref={textareaRef}
					rows={1}
					data-testid={inputTestId}
					className="customizer-composer__input"
					placeholder={placeholder}
					aria-label={inputAriaLabel}
					maxLength={maxLength}
					disabled={disabled}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={handleKeyDown}
				/>
				{showReset && onReset !== undefined ? (
					<button
						type="button"
						className="customizer-composer__new-chat"
						data-action={resetAction}
						disabled={running}
						title={resetLabel}
						aria-label={resetLabel}
						onClick={onReset}
					>
						<RotateCcw size={14} />
					</button>
				) : null}
				{running ? (
					<button
						type="button"
						className="customizer-composer__send is-stop"
						data-action={stopAction}
						title={stopLabel}
						aria-label={stopLabel}
						onClick={onStop}
					>
						<Square size={12} fill="currentColor" />
					</button>
				) : value.trim().length === 0 && voice !== undefined && !disabled ? (
					<VoiceButton voice={voice} onTranscript={(text) => onChange(appendTranscript(value, text))} onError={() => {}} />
				) : (
					<button
						type="button"
						className="customizer-composer__send"
						data-action={sendAction}
						disabled={disabled || value.trim().length === 0}
						title={sendLabel}
						aria-label={sendLabel}
						onClick={onSend}
					>
						<ArrowUp size={12} strokeWidth={2.4} />
					</button>
				)}
			</div>
		</footer>
	);
}

export interface SidebarChatShellProps extends HTMLAttributes<HTMLElement> {
	readonly running: boolean;
	/** Any dependency key that should keep the thread pinned to the bottom when auto-following. */
	readonly followKey: string | number;
	readonly footer: ReactNode;
	readonly children: ReactNode;
}

/** Shared right-sidebar chat container matching Settings & Finder Inspector styling and scroll behavior. */
export function SidebarChatShell({
	running,
	followKey,
	footer,
	children,
	className,
	...rest
}: SidebarChatShellProps): ReactElement {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef(true);
	const [awayFromBottom, setAwayFromBottom] = useState(false);

	useEffect(() => {
		const container = scrollRef.current;
		if (container !== null && followRef.current) {
			container.scrollTop = container.scrollHeight;
		}
	}, [followKey, running]);

	const onBodyScroll = (): void => {
		const body = scrollRef.current;
		if (body === null) return;
		const away = body.scrollHeight - body.scrollTop - body.clientHeight > 120;
		followRef.current = !away;
		setAwayFromBottom(away);
	};

	const scrollToBottom = (): void => {
		const body = scrollRef.current;
		if (body === null) return;
		followRef.current = true;
		setAwayFromBottom(false);
		body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
	};

	return (
		<aside className={className ? `customizer-panel ${className}` : "customizer-panel"} {...rest}>
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div ref={scrollRef} className="customizer-panel__body" onScroll={onBodyScroll}>
					{children}
				</div>
				{awayFromBottom ? <ScrollToBottomButton answering={running} onClick={scrollToBottom} /> : null}
			</div>
			{footer}
		</aside>
	);
}
