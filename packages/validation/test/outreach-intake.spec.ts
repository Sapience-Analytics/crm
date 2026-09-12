import { describe, expect, test } from "bun:test";
import { importCandidatesInput } from "../src/outreach-intake";

function candidate() {
	return {
		company: "Example Fleet",
		domain: "example.test",
		email: null,
		industry: "transport",
		fleetBand: "unknown",
		fleetEvidence: "unknown",
		fit: "Operates delivery vehicles in Western Australia",
		sourceUrl: "https://example.test/fleet",
		sourceQuote: "We operate delivery vehicles across Perth.",
		waQuote: "Perth",
	};
}

describe("candidate intake manifest", () => {
	test("accepts sourced research and preserves its exact quote", () => {
		const input = importCandidatesInput.parse({ prospects: [candidate()] });
		expect(input.prospects[0]?.sourceQuote).toBe(candidate().sourceQuote);
		expect(input.prospects[0]?.email).toBeNull();
	});
	test("normalizes the optional www domain prefix for deduplication", () => {
		const input = importCandidatesInput.parse({
			prospects: [{ ...candidate(), domain: "www.example.test" }],
		});
		expect(input.prospects[0]?.domain).toBe("example.test");
	});
	test("accepts a separate published contact page with role and email", () => {
		expect(
			importCandidatesInput.safeParse({
				prospects: [
					{
						...candidate(),
						email: "fleet@example.test",
						contactSourceUrl: "https://example.test/contact",
						contactRoleQuote: "Fleet Manager",
					},
				],
			}).success,
		).toBe(true);
	});
	test("rejects a separate contact page without both role quote and email", () => {
		expect(
			importCandidatesInput.safeParse({
				prospects: [
					{ ...candidate(), contactSourceUrl: "https://example.test/contact" },
				],
			}).success,
		).toBe(false);
		expect(
			importCandidatesInput.safeParse({
				prospects: [
					{
						...candidate(),
						contactSourceUrl: "https://example.test/contact",
						contactRoleQuote: "Fleet Manager",
					},
				],
			}).success,
		).toBe(false);
		expect(
			importCandidatesInput.safeParse({
				prospects: [
					{
						...candidate(),
						email: "fleet@example.test",
						contactRoleQuote: "Fleet Manager",
					},
				],
			}).success,
		).toBe(false);
	});
	test("accepts twelve candidates and rejects empty or oversized batches", () => {
		expect(
			importCandidatesInput.safeParse({
				prospects: Array.from({ length: 12 }, candidate),
			}).success,
		).toBe(true);
		expect(
			importCandidatesInput.safeParse({
				prospects: Array.from({ length: 13 }, candidate),
			}).success,
		).toBe(false);
		expect(importCandidatesInput.safeParse({ prospects: [] }).success).toBe(
			false,
		);
	});
	test("rejects fleet size claims and insecure source URLs", () => {
		expect(
			importCandidatesInput.safeParse({
				prospects: [{ ...candidate(), fleetBand: "11–50" }],
			}).success,
		).toBe(false);
		expect(
			importCandidatesInput.safeParse({
				prospects: [{ ...candidate(), fleetEvidence: "We assume 50 vehicles" }],
			}).success,
		).toBe(false);
		expect(
			importCandidatesInput.safeParse({
				prospects: [{ ...candidate(), sourceUrl: "http://example.test/fleet" }],
			}).success,
		).toBe(false);
	});
	for (const field of [
		"verified",
		"checkedAt",
		"consent",
		"status",
		"manual",
		"pilotSlot",
		"companyId",
	])
		test(`rejects supplied ${field} state`, () => {
			expect(
				importCandidatesInput.safeParse({
					prospects: [{ ...candidate(), [field]: "forged" }],
				}).success,
			).toBe(false);
		});
});
