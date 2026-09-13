import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { evidenceSchema } from "@crm/validation/outreach";
import {
	assessPublishedEligibility,
	hasMarketingRestriction,
	hasPublishedOperationalRole,
} from "../agent/lib/outreach-eligibility-source";
import * as sources from "../agent/lib/outreach-research";

const domain = "eligibility-source.test";
const contactUrl = `https://${domain}/contact`;
const sourceUrl = `https://${domain}/`;
const evidence = evidenceSchema.parse({
	company: "Example Transport",
	domain,
	email: `alex@${domain}`,
	industry: "transport",
	fleetBand: "unknown",
	fleetEvidence: "unknown",
	fit: "Delivery trucks serve customers across Western Australia.",
	sourceUrl,
	sourceQuote: "We operate delivery trucks across Perth.",
	waQuote: "Perth, Western Australia",
	checkedAt: new Date().toISOString(),
	verified: true,
	contactSourceUrl: contactUrl,
	contactRoleQuote: `Alex Smith Operations Manager alex@${domain}`,
	contactTarget: {
		id: "a".repeat(64),
		kind: "named",
		name: "Alex Smith",
		role: "operations",
		roleTitle: "Operations Manager",
		email: `alex@${domain}`,
		sourceUrl: contactUrl,
		associationQuote: `Alex Smith Operations Manager alex@${domain}`,
		employmentQuote: "Alex Smith Operations Manager",
		verified: true,
		checkedAt: new Date().toISOString(),
	},
});
const home = `<main><p>${evidence.sourceQuote}</p><p>${evidence.waQuote}</p></main>`;
const contact = `<section><h2>Alex Smith</h2><p>Operations Manager</p><p><a href="mailto:alex@${domain}">alex@${domain}</a></p></section>`;
const pages = new Map<string, { text: string; url: URL }>();
const sourceSpy = spyOn(sources, "readSource");

beforeEach(() => {
	pages.clear();
	pages.set(sourceUrl, { text: home, url: new URL(sourceUrl) });
	pages.set(contactUrl, { text: contact, url: new URL(contactUrl) });
	sourceSpy.mockReset();
	sourceSpy.mockImplementation(async (url) => pages.get(url) ?? null);
});

afterAll(() => sourceSpy.mockRestore());

test("records a fresh exact published operational association and complete page hashes", async () => {
	const result = await assessPublishedEligibility(evidence);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("Expected eligible source");
	expect(result.consent.kind).toBe("published-business-role");
	expect(result.assessment.email).toBe(evidence.email);
	expect(result.assessment.associationQuote).toBe(
		evidence.contactTarget?.associationQuote,
	);
	expect(result.assessment.pages).toHaveLength(2);
	expect(
		result.assessment.pages.every((page) => /^[a-f0-9]{64}$/.test(page.sha256)),
	).toBe(true);
});

test("accepts an explicitly labelled operations department but refuses generic publication", async () => {
	const department = evidenceSchema.parse({
		...evidence,
		email: `operations@${domain}`,
		contactRoleQuote: `Operations Department operations@${domain}`,
		contactTarget: {
			...evidence.contactTarget,
			kind: "department",
			name: null,
			role: "department",
			roleTitle: "Operations Department",
			email: `operations@${domain}`,
			associationQuote: `Operations Department operations@${domain}`,
			employmentQuote: `Operations Department operations@${domain}`,
		},
	});
	pages.set(contactUrl, {
		text: `<section>Operations Department <a href="mailto:operations@${domain}">operations@${domain}</a></section>`,
		url: new URL(contactUrl),
	});
	expect((await assessPublishedEligibility(department)).ok).toBe(true);
	const generic = evidenceSchema.parse({
		...department,
		email: `info@${domain}`,
		contactRoleQuote: `General enquiries info@${domain}`,
		contactTarget: {
			...department.contactTarget,
			roleTitle: "General enquiries",
			email: `info@${domain}`,
			associationQuote: `General enquiries info@${domain}`,
			employmentQuote: `General enquiries info@${domain}`,
		},
	});
	pages.set(contactUrl, {
		text: `<section>General enquiries info@${domain}</section>`,
		url: new URL(contactUrl),
	});
	expect((await assessPublishedEligibility(generic)).ok).toBe(false);
});

test("a department email local part does not invent a published operational role", () => {
	const candidate = evidenceSchema.parse({
		...evidence,
		email: `operations@${domain}`,
		contactTarget: {
			...evidence.contactTarget,
			kind: "department",
			name: null,
			role: "department",
			roleTitle: "Operations",
			email: `operations@${domain}`,
			associationQuote: `Contact operations@${domain}`,
			employmentQuote: `Contact operations@${domain}`,
		},
	});
	expect(
		hasPublishedOperationalRole(
			candidate,
			`<section>Contact operations@${domain}</section>`,
		),
	).toBe(false);
});

test("refuses broad leadership titles without an operational role and non-road equipment evidence", () => {
	const director = evidenceSchema.parse({
		...evidence,
		contactTarget: {
			...evidence.contactTarget,
			role: "managing-director",
			roleTitle: "Managing Director",
		},
	});
	expect(hasPublishedOperationalRole(director, contact)).toBe(false);
	expect(
		hasPublishedOperationalRole(
			{
				...evidence,
				sourceQuote: "Our modern fleet provides excellent service.",
			},
			contact,
		),
	).toBe(false);
});

test("rejects an unrelated mailbox link, footer association and changed official role", async () => {
	for (const text of [
		contact.replace(`mailto:alex@${domain}`, `mailto:other@${domain}`),
		`<footer>${contact}</footer>`,
		contact.replace("Operations Manager", "Sales Manager"),
	]) {
		pages.set(contactUrl, { text, url: new URL(contactUrl) });
		expect((await assessPublishedEligibility(evidence)).ok).toBe(false);
	}
});

test("reads linked policies and rejects a restriction outside the contact card", async () => {
	const policy = `https://${domain}/privacy`;
	pages.set(sourceUrl, {
		text: `${home}<footer><a href="/privacy">Privacy policy</a></footer>`,
		url: new URL(sourceUrl),
	});
	pages.set(policy, {
		text: "<main><p>Do not use our contact details for unsolicited commercial email.</p></main>",
		url: new URL(policy),
	});
	expect((await assessPublishedEligibility(evidence)).ok).toBe(false);
	expect(sourceSpy.mock.calls.map((call) => call[0])).toContain(policy);
});

test.each([
	"We do not accept unsolicited commercial email.",
	"Email addresses must not be used for marketing.",
	"Advertising messages are not permitted.",
	"Do not contact us with offers.",
	"No solicitation.",
	"Use of this information for promotional purposes is prohibited.",
	"Publication of email addresses does not constitute consent to commercial messages.",
	"These email addresses are only for freight booking enquiries.",
	"No unsolicited marketing.",
])("holds a published restriction: %s", (text) => {
	expect(hasMarketingRestriction(`<p>${text}</p>`)).toBe(true);
});

test.each([
	"We never sell your information for marketing.",
	"We do not send unsolicited marketing emails.",
	"We do not share personal information with advertisers.",
	"We will not use your information for promotional purposes without your consent.",
])(
	"outgoing privacy practice is not an incoming-contact restriction: %s",
	(text) => {
		expect(hasMarketingRestriction(`<p>${text}</p>`)).toBe(false);
	},
);

test("unreadable, external and excessive linked policies remain held", async () => {
	for (const links of [
		"<a href='/terms.pdf'>Terms</a>",
		"<a href='https://other.test/privacy'>Privacy</a>",
		Array.from(
			{ length: 7 },
			(_, index) => `<a href='/privacy-${index}'>Privacy</a>`,
		).join(""),
	]) {
		pages.set(sourceUrl, { text: home + links, url: new URL(sourceUrl) });
		expect((await assessPublishedEligibility(evidence)).ok).toBe(false);
	}
});

test("follows nested policy links once and holds an unreadable final policy", async () => {
	const privacy = `https://${domain}/privacy`;
	const terms = `https://${domain}/terms`;
	pages.set(sourceUrl, {
		text: `${home}<a href='/privacy'>Privacy</a>`,
		url: new URL(sourceUrl),
	});
	pages.set(privacy, {
		text: "<main><p>Privacy information.</p><a href='/terms'>Terms</a><a href='/privacy'>Privacy</a></main>",
		url: new URL(privacy),
	});
	expect((await assessPublishedEligibility(evidence)).ok).toBe(false);
	expect(
		sourceSpy.mock.calls.filter((call) => call[0] === privacy),
	).toHaveLength(1);
	expect(sourceSpy.mock.calls.map((call) => call[0])).toContain(terms);
});

test("rejects missing source evidence, future timestamps and external redirects", async () => {
	pages.set(sourceUrl, {
		text: "<main>Different operations and location.</main>",
		url: new URL(sourceUrl),
	});
	expect((await assessPublishedEligibility(evidence)).ok).toBe(false);
	expect(
		(
			await assessPublishedEligibility({
				...evidence,
				checkedAt: new Date(Date.now() + 60_000).toISOString(),
			})
		).ok,
	).toBe(false);
	pages.set(sourceUrl, { text: home, url: new URL("https://other.test/") });
	expect((await assessPublishedEligibility(evidence)).ok).toBe(false);
});
