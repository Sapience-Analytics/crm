import { createHash } from "node:crypto";
import type { ContactResearchCandidate } from "@crm/validation/outreach-contact-target";
import { verifiedContactCandidateSchema } from "@crm/validation/outreach-contact-target";
import { CONTACT_RESEARCH } from "@crm/validation/outreach-contacts";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { getDomain } from "tldts";
import { decodeCloudflareEmail } from "./outreach-email-source";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export function normalizeContactText(value: string) {
	return value
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function element(node: Node): node is Element {
	return "tagName" in node;
}

function attr(node: Element, name: string) {
	return node.attrs.find((attribute) => attribute.name === name)?.value ?? "";
}

function excluded(node: Element) {
	return (
		["script", "style", "template", "noscript"].includes(node.tagName) ||
		node.attrs.some((attribute) => attribute.name === "hidden") ||
		attr(node, "aria-hidden") === "true" ||
		/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(node, "style"))
	);
}

function text(node: Node): string {
	if ("value" in node) return node.value;
	if (!("childNodes" in node) || (element(node) && excluded(node))) return "";
	const content = node.childNodes.map(text).join("");
	if (!element(node)) return content;
	const href = attr(node, "href");
	const encoded =
		attr(node, "data-cfemail") ||
		href.split("/cdn-cgi/l/email-protection#")[1] ||
		"";
	const decoded = decodeCloudflareEmail(encoded);
	if (decoded) return decoded;
	const email = href.startsWith("mailto:")
		? (href.slice(7).split("?")[0] ?? "")
		: "";
	const linked =
		email && !normalizeContactText(content).includes(email.toLowerCase())
			? `${content} ${email}`
			: content;
	return ["span", "a", "strong", "b", "i", "em"].includes(node.tagName)
		? linked
		: ` ${linked} `;
}

function elements(node: Node): Element[] {
	if (!("childNodes" in node)) return [];
	if (element(node) && excluded(node)) return [];
	return [
		...(element(node) ? [node] : []),
		...node.childNodes.flatMap(elements),
	];
}

export function visibleContactText(html: string) {
	return normalizeContactText(text(parse(html)));
}

function forbiddenContext(node: Element) {
	let current: Node | null = node;
	while (current && element(current)) {
		const label = `${attr(current, "class")} ${attr(current, "id")} ${attr(current, "aria-label")}`;
		if (
			["footer", "blockquote"].includes(current.tagName) ||
			/testimonial|customer[-_ ]?review|former|previous[-_ ]?staff/i.test(label)
		)
			return true;
		current = current.parentNode;
	}
	return false;
}

export function verifyContactCandidate(
	candidate: ContactResearchCandidate,
	companyDomain: string,
	existingEmail: string | null,
	html: string,
	finalUrl: URL,
	checkedAt = new Date(),
) {
	const root = getDomain(companyDomain, { allowPrivateDomains: true });
	if (
		!root ||
		root !== companyDomain ||
		finalUrl.protocol !== "https:" ||
		getDomain(finalUrl.hostname, { allowPrivateDomains: true }) !== root
	)
		return null;
	if (
		/\b(?:19|20)\d{2}\b|polic(?:y|ies)|archive|history|testimonial/i.test(
			finalUrl.pathname,
		)
	)
		return null;
	const quote = normalizeContactText(candidate.associationQuote);
	const employment = normalizeContactText(candidate.employmentQuote);
	if (
		/\b(?:former|previously|retired|resigned|left the company|customer testimonial)\b/.test(
			`${quote} ${employment}`,
		)
	)
		return null;
	const document = parse(html);
	const visible = normalizeContactText(text(document));
	if (!visible.includes(quote) || !visible.includes(employment)) return null;
	const email = candidate.email?.toLowerCase() ?? null;
	if (email && (!quote.includes(email) || !visible.includes(email)))
		return null;
	if (
		candidate.kind === "department" &&
		email &&
		email.split("@")[1] !== companyDomain &&
		email !== existingEmail?.toLowerCase()
	)
		return null;
	if (candidate.kind === "named") {
		const name = normalizeContactText(candidate.name ?? "");
		const role = normalizeContactText(candidate.roleTitle);
		const rolePatterns = {
			fleet: /\bfleet\b/,
			transport: /\btransport\b/,
			operations: /\boperations?\b/,
			owner: /\b(?:owner|founder|proprietor)\b/,
			"managing-director": /\bmanaging director\b/,
			"branch-manager": /\b(?:branch|state|regional) manager\b/,
			"general-manager": /\bgeneral manager\b/,
			department: /$a/,
		};
		if (
			!rolePatterns[candidate.role].test(role) ||
			/\b(?:hr|human resources|admin|sales|marketing|customer)\b/.test(role)
		)
			return null;
		if (
			!name ||
			!quote.includes(name) ||
			!quote.includes(role) ||
			!employment.includes(name) ||
			!employment.includes(role)
		)
			return null;
		const emailDomain = email?.split("@")[1];
		if (
			emailDomain &&
			emailDomain !== companyDomain &&
			emailDomain !== existingEmail?.split("@")[1]
		)
			return null;
		const block = elements(document).some((node) => {
			if (
				["html", "body", "main", "header", "nav", "footer"].includes(
					node.tagName,
				) ||
				forbiddenContext(node)
			)
				return false;
			if (elements(node).some((child) => child.tagName === "footer"))
				return false;
			const content = normalizeContactText(text(node));
			if (
				content.length > CONTACT_RESEARCH.maxBlockChars ||
				!content.includes(quote) ||
				!content.includes(employment)
			)
				return false;
			const addresses = new Set(
				content.match(
					/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g,
				) ?? [],
			);
			return (
				addresses.size <= 1 &&
				!/\b(?:testimonial|our customers say|former|retired|resigned)\b/.test(
					content,
				)
			);
		});
		if (!block) return null;
	}
	const id = createHash("sha256")
		.update(JSON.stringify({ version: CONTACT_RESEARCH.version, ...candidate }))
		.digest("hex");
	return verifiedContactCandidateSchema.parse({
		...candidate,
		id,
		verified: true,
		checkedAt: checkedAt.toISOString(),
	});
}
