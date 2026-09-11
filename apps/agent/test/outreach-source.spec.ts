import { expect, test } from "bun:test";
import { evidenceSchema } from "@crm/validation/outreach";
import { verifyProspectSource } from "../agent/lib/outreach-research";

const evidence = evidenceSchema.parse({
	company: "Example",
	domain: "example.test",
	email: "fleet@example.test",
	industry: "transport",
	fleetBand: "unknown",
	fleetEvidence: "Unknown",
	fit: "A WA delivery fleet for further investigation",
	sourceUrl: "https://example.test",
	sourceQuote: "We operate delivery vehicles across Perth.",
	waQuote: "Perth",
	checkedAt: "2026-09-12T00:00:00.000Z",
	verified: false,
});
const body =
	"<p>We operate delivery vehicles across Perth.</p><a href='mailto:fleet@example.test'>Email</a>";

test("requires exact primary-source facts and email", () => {
	expect(
		verifyProspectSource(evidence, body, new URL(evidence.sourceUrl)),
	).toBe(true);
	expect(
		verifyProspectSource(
			evidence,
			body.replace("delivery", "rental"),
			new URL(evidence.sourceUrl),
		),
	).toBe(false);
	expect(
		verifyProspectSource(
			evidence,
			body.replace("fleet@example.test", "info@example.test"),
			new URL(evidence.sourceUrl),
		),
	).toBe(false);
});
test("rejects copied quotations hosted on another domain", () => {
	expect(
		verifyProspectSource(evidence, body, new URL("https://directory.test")),
	).toBe(false);
	expect(
		verifyProspectSource(
			evidence,
			body,
			new URL("https://example.test.evil.test"),
		),
	).toBe(false);
});
