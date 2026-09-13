import { createHash } from "node:crypto";
import { consentSchema, type ProspectEvidence } from "@crm/validation/outreach";
import { CONTACT_RESEARCH } from "@crm/validation/outreach-contacts";
import { OUTREACH_AUTOMATION } from "@crm/validation/outreach-referrals";
import { type DefaultTreeAdapterTypes, parse, serializeOuter } from "parse5";
import { getDomain } from "tldts";
import {
	normalizeContactText,
	visibleContactText,
} from "./outreach-contact-source";
import { readSource, verifyProspectSource } from "./outreach-research";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
type Source = NonNullable<Awaited<ReturnType<typeof readSource>>>;

function attribute(node: Element, name: string) {
	return node.attrs.find((item) => item.name === name)?.value ?? "";
}

function elements(node: Node): Element[] {
	if (!("childNodes" in node)) return [];
	if (
		"tagName" in node &&
		(["script", "style", "template", "noscript", "blockquote"].includes(
			node.tagName,
		) ||
			node.attrs.some((item) => item.name === "hidden") ||
			attribute(node, "aria-hidden") === "true" ||
			/display\s*:\s*none|visibility\s*:\s*hidden/i.test(
				attribute(node, "style"),
			))
	)
		return [];
	return [
		...("tagName" in node ? [node] : []),
		...node.childNodes.flatMap(elements),
	];
}

function companyUrl(url: URL, domain: string) {
	return (
		url.protocol === "https:" &&
		!url.username &&
		!url.password &&
		getDomain(url.hostname, { allowPrivateDomains: true }) === domain
	);
}

export function hasPublishedOperationalRole(
	evidence: ProspectEvidence,
	html: string,
) {
	const target = evidence.contactTarget;
	if (!target?.email || target.email !== evidence.email) return false;
	if (
		target.kind === "named" &&
		!["fleet", "transport", "operations"].includes(target.role)
	)
		return false;
	const role = normalizeContactText(target.roleTitle);
	if (
		!/\b(?:fleet|transport|operations?)\b/.test(role) ||
		/\b(?:sales|marketing|customer|booking|admin|human resources|recruitment|hr)\b/.test(
			role,
		)
	)
		return false;
	if (
		!/\b(?:trucks?|prime movers?|vans?|buses|coaches|haulage|(?:road|delivery) vehicles?|road (?:transport|freight))\b/i.test(
			evidence.sourceQuote,
		)
	)
		return false;
	const quote = normalizeContactText(target.associationQuote);
	const employment = normalizeContactText(target.employmentQuote);
	const withoutEmails = (value: string) =>
		value.replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g, "");
	if (
		!withoutEmails(quote).includes(role) ||
		!withoutEmails(employment).includes(role)
	)
		return false;
	return elements(parse(html)).some((node) => {
		if (!["p", "div", "section", "li", "td", "article"].includes(node.tagName))
			return false;
		let parent: Node | null = node;
		while (parent && "tagName" in parent) {
			if (
				["footer", "header", "nav", "blockquote"].includes(parent.tagName) ||
				/testimonial|former|previous[-_ ]?staff|customer[-_ ]?review/i.test(
					`${attribute(parent, "id")} ${attribute(parent, "class")}`,
				)
			)
				return false;
			parent = parent.parentNode;
		}
		const content = visibleContactText(serializeOuter(node));
		if (
			content.length > CONTACT_RESEARCH.maxBlockChars ||
			!content.includes(quote) ||
			!content.includes(employment)
		)
			return false;
		const emails = new Set(
			content.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ??
				[],
		);
		return emails.size === 1 && emails.has(target.email ?? "");
	});
}

export function hasMarketingRestriction(html: string) {
	const text = visibleContactText(html);
	return (
		/\b(?:publication|publishing|published|listing|listed)\b.{0,100}\b(?:addresses|emails?)\b.{0,100}\b(?:not|no)\b.{0,80}\b(?:consent|permission|invitation)\b/.test(
			text,
		) ||
		/\b(?:addresses|contact (?:details|information))\b.{0,80}\b(?:only|solely|exclusively) for\b/.test(
			text,
		) ||
		/\b(?:no|reject|refuse) unsolicited\b/.test(text) ||
		/\b(?:no solicit(?:ation|ing)|no unsolicited (?:commercial )?(?:emails?|messages?|offers)|do not contact us|do not email us)\b/.test(
			text,
		) ||
		/\b(?:do not|does not|will not|never|don't|won't)\s+(?:accept|want|wish to receive|permit)\b.{0,80}\b(?:unsolicited|commercial|marketing|advertis\w*|promotional|spam)\b/.test(
			text,
		) ||
		/\b(?:do not|don't|must not|never)\s+(?:use (?:these|our|the|any|this)|send (?:us|our))\b.{0,120}\b(?:marketing|promotional|advertis\w*|commercial|offers|spam)\b/.test(
			text,
		) ||
		/\b(?:addresses|contact (?:details|information))\b.{0,80}\b(?:must not|may not|shall not|not to be|cannot|not permitted|not allowed|only for)\b.{0,100}\b(?:marketing|promotional|advertis\w*|commercial|solicitation)\b/.test(
			text,
		) ||
		/\b(?:use|using)\b.{0,60}\b(?:addresses|contact details|this information)\b.{0,100}\b(?:marketing|promotional|advertis\w*|commercial)\b.{0,80}\b(?:prohibited|forbidden|not allowed|not permitted)\b/.test(
			text,
		) ||
		/\b(?:advertising|unsolicited|marketing|commercial) (?:emails?|messages?|contact|offers)\b.{0,80}\b(?:not accepted|not permitted|prohibited|forbidden|prior consent|express consent|prior permission)\b/.test(
			text,
		)
	);
}

export function linkedContactPolicies(html: string, base: URL, domain: string) {
	const urls = new Set<string>();
	for (const node of elements(parse(html))) {
		if (node.tagName !== "a") continue;
		const href = attribute(node, "href");
		const label = visibleContactText(serializeOuter(node));
		if (
			!/privacy|terms|legal|spam|acceptable[-_ ]?use|contact[-_ ]?polic|t&c/i.test(
				`${label} ${href}`,
			)
		)
			continue;
		if (!href || href.startsWith("#")) continue;
		let url: URL;
		try {
			url = new URL(href, base);
		} catch {
			return null;
		}
		url.hash = "";
		if (!companyUrl(url, domain)) return null;
		urls.add(url.href);
	}
	return [...urls];
}

export async function assessPublishedEligibility(evidence: ProspectEvidence) {
	const target = evidence.contactTarget;
	if (
		!evidence.verified ||
		!target?.email ||
		target.email !== evidence.email ||
		target.sourceUrl !== evidence.contactSourceUrl ||
		Date.parse(evidence.checkedAt) > Date.now() ||
		Date.parse(target.checkedAt) > Date.now()
	)
		return {
			ok: false as const,
			reason: "A verified current contact and company source are required.",
		};
	const pages = new Map<string, Source>();
	const sourceUrls = new Set([
		evidence.sourceUrl,
		target.sourceUrl,
		`https://${evidence.domain}/`,
	]);
	for (const url of sourceUrls) {
		const source = await readSource(url);
		if (!source || !companyUrl(source.url, evidence.domain))
			return {
				ok: false as const,
				reason:
					"Official source pages are unavailable. Contact eligibility stays held.",
			};
		pages.set(url, source);
	}
	const source = pages.get(evidence.sourceUrl);
	const contact = pages.get(target.sourceUrl);
	if (
		!source ||
		!contact ||
		!verifyProspectSource(evidence, source.text, source.url, contact) ||
		!hasPublishedOperationalRole(evidence, contact.text)
	)
		return {
			ok: false as const,
			reason:
				"Published evidence does not bind this address to a relevant road-fleet operational role.",
		};
	const policyUrls = new Set<string>();
	for (const page of pages.values()) {
		const links = linkedContactPolicies(page.text, page.url, evidence.domain);
		if (!links)
			return {
				ok: false as const,
				reason: "A linked contact policy needs owner review.",
			};
		for (const url of links) if (!pages.has(url)) policyUrls.add(url);
	}
	if (policyUrls.size > OUTREACH_AUTOMATION.eligibility.policyPageLimit)
		return {
			ok: false as const,
			reason: "Linked policy pages exceed the automatic review limit.",
		};
	for (const url of policyUrls) {
		const page = await readSource(url);
		if (
			!page ||
			!companyUrl(page.url, evidence.domain) ||
			!/<(?:html|body|p|div|section)\b/i.test(page.text)
		)
			return {
				ok: false as const,
				reason:
					"A linked contact policy is unreadable. Contact eligibility stays held.",
			};
		pages.set(url, page);
		const links = linkedContactPolicies(page.text, page.url, evidence.domain);
		if (!links)
			return {
				ok: false as const,
				reason: "A linked contact policy needs owner review.",
			};
		for (const linked of links) if (!pages.has(linked)) policyUrls.add(linked);
		if (policyUrls.size > OUTREACH_AUTOMATION.eligibility.policyPageLimit)
			return {
				ok: false as const,
				reason: "Linked policy pages exceed the automatic review limit.",
			};
	}
	if ([...pages.values()].some((page) => hasMarketingRestriction(page.text)))
		return {
			ok: false as const,
			reason:
				"Published marketing-contact policy wording requires owner assessment.",
		};
	const checkedAt = new Date().toISOString();
	const relevance =
		"Geotab vehicle location, trip reporting and maintenance information relates to the published fleet, transport or operations function and sourced road-vehicle activity.";
	const assessment = {
		version: OUTREACH_AUTOMATION.version,
		kind: "published-business-role",
		checkedAt,
		email: target.email,
		roleTitle: target.roleTitle,
		associationQuote: target.associationQuote,
		employmentQuote: target.employmentQuote,
		operationQuote: evidence.sourceQuote,
		relevance,
		publicationAgreementBasis:
			"The company's own current contact page publishes the role and address together.",
		restrictionResult:
			"No restriction detected in the examined complete official pages. This is an inferred basis, not express consent.",
		pages: [...pages.values()].map((page) => ({
			url: page.url.href,
			sha256: createHash("sha256").update(page.text).digest("hex"),
		})),
	};
	const consent = consentSchema.parse({
		kind: "published-business-role",
		evidence: `Official contact publication associates ${target.email} with ${target.roleTitle}. ${relevance} The operational, contact, home and linked policy pages contain no detected marketing-contact restriction. The recorded assessment retains exact evidence and page hashes. Inferred consent is limited to this relevant business role.`,
		source: target.sourceUrl,
		roleRelevant: true,
		noRestriction: true,
		verifiedBy: "automatic-published-role-assessment",
		verifiedAt: checkedAt,
	});
	return { ok: true as const, assessment, consent };
}
