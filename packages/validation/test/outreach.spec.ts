import { describe, expect, test } from "bun:test";
import {
	contactEligible,
	DEFAULT_TEMPLATES,
	evidenceSchema,
	followupDue,
	OUTREACH,
	perthDay,
	renderEmail,
	sendWindow,
	stopReason,
	templatesSchema,
	weekStart,
} from "../src/outreach";

const evidence = evidenceSchema.parse({
	company: "Example Fleet",
	domain: "example.test",
	email: "fleet@example.test",
	industry: "transport",
	fleetBand: "unknown",
	fleetEvidence: "Not verified",
	fit: "Operates delivery vehicles in Western Australia",
	sourceUrl: "https://example.test/about",
	sourceQuote: "We operate delivery vehicles across Perth.",
	waQuote: "Perth",
	checkedAt: "2026-09-12T00:00:00.000Z",
	verified: true,
});

describe("outreach sending policy", () => {
	test("uses Perth weekdays and exact boundaries", () => {
		expect(sendWindow(new Date("2026-09-14T01:59:59Z"))).toBe(false);
		expect(sendWindow(new Date("2026-09-14T02:00:00Z"))).toBe(true);
		expect(sendWindow(new Date("2026-09-14T06:59:59Z"))).toBe(true);
		expect(sendWindow(new Date("2026-09-14T07:00:00Z"))).toBe(false);
		expect(sendWindow(new Date("2026-09-12T02:00:00Z"))).toBe(false);
		expect(perthDay(new Date("2026-09-13T18:00:00Z"))).toBe("2026-09-14");
		expect(weekStart(new Date("2026-09-13T18:00:00Z")).toISOString()).toBe(
			"2026-09-13T16:00:00.000Z",
		);
	});
	test("followups count business days from the initial send", () => {
		const initial = new Date("2026-09-11T03:00:00Z");
		expect(followupDue(initial, 1).toISOString()).toBe(
			"2026-09-17T03:00:00.000Z",
		);
		expect(followupDue(initial, 2).toISOString()).toBe(
			"2026-09-25T03:00:00.000Z",
		);
		expect(() => followupDue(initial, 3)).toThrow();
	});
	test("a published email never establishes eligibility alone", () => {
		expect(contactEligible(evidence, null)).toBe(false);
	});
	test("rendering keeps the exact source quotation and unsubscribe", () => {
		const initial = renderEmail(DEFAULT_TEMPLATES, evidence, 0);
		expect(initial.body).toContain(evidence.sourceQuote);
		expect(initial.body).toContain("reply unsubscribe");
		expect(initial.body).toContain(OUTREACH.sender);
		expect(initial.subject).toBe("Fleet needs at Example Fleet");
		expect(renderEmail(DEFAULT_TEMPLATES, evidence, 1).body).not.toContain(
			evidence.sourceQuote,
		);
	});
	test("rejects header injection and unapproved template fields", () => {
		expect(
			templatesSchema.safeParse({
				...DEFAULT_TEMPLATES,
				subject: "Test\r\nBcc: victim@example.test",
			}).success,
		).toBe(false);
		expect(
			templatesSchema.safeParse({
				...DEFAULT_TEMPLATES,
				initial: "A long enough body with {{inventedSavings}}",
			}).success,
		).toBe(false);
	});
	test("all reply classes stop sending, including out-of-office", () => {
		expect(stopReason("person@example.test", "I'm away until Monday")).toBe(
			"REPLIED",
		);
		expect(stopReason("person@example.test", "Please unsubscribe me")).toBe(
			"SUPPRESSED",
		);
		expect(stopReason("mailer-daemon@example.test", "delivery failed")).toBe(
			"BOUNCED",
		);
	});
});
