import type { MailMessage } from "../shared/mail";
import { sanitizeMarkdownHtml } from "./markdown-html";

/**
 * HTML mail through the same inert-document allowlist as Markdown, with its
 * `cid:` images swapped for the data URIs the parser decoded. With no folder to
 * resolve against, every other image (remote or relative) is dropped, so the
 * preview never reaches the network.
 */
export function renderMailHtml(mail: MailMessage): string {
	const html = (mail.html ?? "").replace(/\bcid:([^"'\s>)]+)/gi, (whole, id: string) => mail.inlineImages[id] ?? mail.inlineImages[decodeURIComponent(id)] ?? whole);
	// An image the sanitizer stripped of its remote `src` would draw as a broken icon with its alt text.
	return sanitizeMarkdownHtml(html, null).replace(/<img(?![^>]*\ssrc=)[^>]*>/gi, "");
}
