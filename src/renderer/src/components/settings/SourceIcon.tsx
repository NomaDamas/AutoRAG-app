/**
 * Representative icon for a datasource template: the product's own logo
 * (nominative use — the icon names the product the connection reads from).
 * Marks come from `simple-icons` (CC0) except Slack and Lark, which it does not
 * ship; those two are inlined from `slackMark.ts` / `larkMark.ts`. Templates
 * with no single product behind them (cloud drive, mail export, …) use a
 * neutral lucide glyph.
 */

import type { ReactElement } from "react";
import { Calendar, Cloud, Folder, Globe, Images, Mail, Search, type LucideIcon } from "lucide-react";
import {
	siDiscord,
	siGithub,
	siKakaotalk,
	siNotion,
	siObsidian,
	siRss,
	siTelegram,
	siWhatsapp,
	type SimpleIcon,
} from "simple-icons";
import { LARK_MARK } from "./larkMark";
import { SLACK_MARK } from "./slackMark";

const BRAND_BY_TEMPLATE: Readonly<Record<string, SimpleIcon>> = {
	discord: siDiscord,
	github: siGithub,
	"github-gist": siGithub,
	kakao: siKakaotalk,
	notion: siNotion,
	obsidian: siObsidian,
	rss: siRss,
	telegram: siTelegram,
	whatsapp: siWhatsapp,
};

const GLYPH_BY_TEMPLATE: Readonly<Record<string, LucideIcon>> = {
	clawgallery: Images,
	"cloud-drive": Cloud,
	mailcrawl: Mail,
	"mail-export": Mail,
	local: Folder,
	spotlight: Search,
	hister: Globe,
	calendar: Calendar,
	"apple-events": Calendar,
};

/** Marks darker than this vanish on a dark theme, so they follow the text color instead. */
const MIN_BRAND_LUMA = 0.2;

function brandFill(hex: string): string {
	const channel = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
	const luma = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
	return luma < MIN_BRAND_LUMA ? "currentColor" : `#${hex}`;
}

export function SourceIcon({ type, label, small = false }: { readonly type: string; readonly label: string; readonly small?: boolean }): ReactElement {
	const size = small ? 12 : 18;
	const brand = BRAND_BY_TEMPLATE[type];
	const Glyph = GLYPH_BY_TEMPLATE[type];
	let mark: ReactElement;
	if (brand !== undefined) {
		mark = (
			<svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={label} focusable="false">
				<path d={brand.path} fill={brandFill(brand.hex)} />
			</svg>
		);
	} else if (type === "slack") {
		mark = (
			<svg viewBox="0 0 256 256" width={size} height={size} role="img" aria-label={label} focusable="false">
				{SLACK_MARK.map((part) => (
					<path key={part.fill} d={part.d} fill={part.fill} />
				))}
			</svg>
		);
	} else if (type === "lark") {
		mark = (
			<svg viewBox="0 0 48 48" width={size} height={size} role="img" aria-label={label} focusable="false">
				<path d={LARK_MARK} fill="currentColor" fillRule="evenodd" />
			</svg>
		);
	} else if (Glyph !== undefined) {
		mark = <Glyph size={size} aria-label={label} role="img" focusable="false" />;
	} else {
		mark = <span aria-hidden="true">{(label.trim().slice(0, 1) || "·").toUpperCase()}</span>;
	}
	return <span className={`settings-app-icon${small ? " is-sm" : ""}`}>{mark}</span>;
}
