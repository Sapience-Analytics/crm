import { afterEach, expect, spyOn, test } from "bun:test";
import * as sourceFetch from "@crm/db/safe-fetch";
import { evidenceSchema, OUTREACH } from "@crm/validation/outreach";
import {
	checkProspectSources,
	decodeCloudflareEmail,
	readSource,
	verifyProspectSource,
} from "../agent/lib/outreach-research";

const restores: (() => void)[] = [];
const evidence = evidenceSchema.parse({
	company: "Example Fleet",
	domain: "example.test",
	email: "fleet@example.test",
	industry: "transport",
	fleetBand: "unknown",
	fleetEvidence: "unknown",
	fit: "Operates delivery vehicles in Western Australia",
	sourceUrl: "https://example.test/fleet",
	sourceQuote: "We operate delivery vehicles across Perth.",
	waQuote: "Perth",
	contactSourceUrl: "https://example.test/contact",
	contactRoleQuote: "Fleet Manager",
	checkedAt: "2026-09-14T03:00:00.000Z",
	verified: false,
});
const primary = "<p>We operate delivery vehicles across Perth.</p>";
const contact =
	"<p>Fleet Manager</p><a href='mailto:fleet@example.test'>Email</a>";

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

test("verifies fleet facts and WA on the primary page with separate contact evidence", () => {
	expect(
		verifyProspectSource(evidence, primary, new URL(evidence.sourceUrl), {
			text: contact,
			url: new URL(evidence.contactSourceUrl ?? ""),
		}),
	).toBe(true);
	expect(
		verifyProspectSource(evidence, primary, new URL(evidence.sourceUrl)),
	).toBe(false);
});

test("requires the exact role and exact email on the separate official contact page", () => {
	for (const text of [
		contact.replace("Fleet Manager", "Accounts"),
		contact.replace("fleet@example.test", "fleet@example.test.evil"),
		contact.replace("fleet@example.test", "another-fleet@example.test"),
	])
		expect(
			verifyProspectSource(evidence, primary, new URL(evidence.sourceUrl), {
				text,
				url: new URL(evidence.contactSourceUrl ?? ""),
			}),
		).toBe(false);
});

test("rejects contact proof from another domain or an insecure redirect", () => {
	for (const url of [
		"https://directory.test/contact",
		"https://example.test.evil.test",
		"http://example.test/contact",
	])
		expect(
			verifyProspectSource(evidence, primary, new URL(evidence.sourceUrl), {
				text: contact,
				url: new URL(url),
			}),
		).toBe(false);
});

test("reads adjacent inline spans without inventing emails across block elements", () => {
	const role = { ...evidence, contactRoleQuote: "fleet@example.test" };
	const url = new URL(evidence.contactSourceUrl ?? "");
	expect(
		verifyProspectSource(role, primary, new URL(evidence.sourceUrl), {
			text: "<p><span>fleet</span><span>@example.test</span></p>",
			url,
		}),
	).toBe(true);
	expect(
		verifyProspectSource(role, primary, new URL(evidence.sourceUrl), {
			text: "<p>fleet</p><p>@example.test</p>",
			url,
		}),
	).toBe(false);
});

test("rejects public suffix claims and redirects into another registered company domain", () => {
	for (const domain of ["com.au", "github.io"])
		expect(
			verifyProspectSource(
				{ ...evidence, domain },
				primary,
				new URL(`https://unrelated.${domain}/fleet`),
				{ text: contact, url: new URL(`https://unrelated.${domain}/contact`) },
			),
		).toBe(false);
});

test("requires the fleet quote and WA quote on the same primary page", () => {
	expect(
		verifyProspectSource(
			evidence,
			"<p>Welcome to our contact page.</p>",
			new URL(evidence.sourceUrl),
			{
				text: primary + contact,
				url: new URL(evidence.contactSourceUrl ?? ""),
			},
		),
	).toBe(false);
	expect(
		verifyProspectSource(
			evidence,
			`<script>${primary}</script>`,
			new URL(evidence.sourceUrl),
			{ text: contact, url: new URL(evidence.contactSourceUrl ?? "") },
		),
	).toBe(false);
});

test("decodes Cloudflare's published email bytes without guessing the address", () => {
	expect(
		decodeCloudflareEmail(
			"f7919b929283b79694839e9899949882859e928584d994989ad99682",
		),
	).toBe("fleet@actioncouriers.com.au");
	for (const invalid of ["", "ff", "abc", "not-hex", "ffff", "0".repeat(644)])
		expect(decodeCloudflareEmail(invalid)).toBeNull();
});

test("verifies the exact Cloudflare email and role on the official company page", () => {
	const action = evidenceSchema.parse({
		...evidence,
		domain: "actioncouriers.com.au",
		email: "fleet@actioncouriers.com.au",
		sourceUrl: "https://www.actioncouriers.com.au/fleet",
		contactSourceUrl: "https://www.actioncouriers.com.au/contact",
	});
	const encoded =
		'<p>Fleet Manager <span data-cfemail="f7919b929283b79694839e9899949882859e928584d994989ad99682">[email protected]</span></p>';
	expect(
		verifyProspectSource(action, primary, new URL(action.sourceUrl), {
			text: encoded,
			url: new URL(action.contactSourceUrl ?? ""),
		}),
	).toBe(true);
	expect(
		verifyProspectSource(
			{ ...action, email: "sales@actioncouriers.com.au" },
			primary,
			new URL(action.sourceUrl),
			{ text: encoded, url: new URL(action.contactSourceUrl ?? "") },
		),
	).toBe(false);
	expect(
		verifyProspectSource(action, primary, new URL(action.sourceUrl), {
			text: `<p>Fleet Manager</p><!-- ${encoded} -->`,
			url: new URL(action.contactSourceUrl ?? ""),
		}),
	).toBe(false);
});

test("reads both source pages through the shared safe fetch boundary", async () => {
	const urls: string[] = [];
	const stub = spyOn(sourceFetch, "safeFetch").mockImplementation(
		async (url) => {
			urls.push(url);
			return {
				response: new Response(url === evidence.sourceUrl ? primary : contact),
				url: new URL(url),
			};
		},
	);
	restores.push(() => stub.mockRestore());
	expect(await checkProspectSources(evidence)).toBe(true);
	expect(urls.sort()).toEqual(
		[evidence.sourceUrl, evidence.contactSourceUrl].sort(),
	);
});

test("rejects oversized source bodies and unavailable sources", async () => {
	const stub = spyOn(sourceFetch, "safeFetch").mockResolvedValue({
		response: new Response("x".repeat(OUTREACH.maxSourceBytes + 1)),
		url: new URL(evidence.sourceUrl),
	});
	restores.push(() => stub.mockRestore());
	expect(await readSource(evidence.sourceUrl)).toBeNull();
	stub.mockResolvedValue(null);
	expect(await checkProspectSources(evidence)).toBe(false);
});
