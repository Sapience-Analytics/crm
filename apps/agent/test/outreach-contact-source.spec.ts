import { expect, test } from "bun:test";
import { contactResearchCandidateSchema } from "@crm/validation/outreach-contact-target";
import { verifyContactCandidate } from "../agent/lib/outreach-contact-source";

const candidate = contactResearchCandidateSchema.parse({
	kind: "named",
	name: "Alex Smith",
	role: "operations",
	roleTitle: "Operations Manager",
	email: "operations@example.test",
	sourceUrl: "https://example.test/contact",
	associationQuote:
		"Alex Smith Operations Manager Phone: 08 1234 5678 operations@example.test",
	employmentQuote: "Alex Smith Operations Manager",
});
const card =
	'<section class="team-card"><h2>Alex Smith</h2><p>Operations Manager</p><p>Phone: 08 1234 5678</p><a href="mailto:operations@example.test">operations@example.test</a></section>';

function verify(html = card, value = candidate, url = value.sourceUrl) {
	return verifyContactCandidate(
		value,
		"example.test",
		"operations@example.test",
		html,
		new URL(url),
	);
}

test("verifies a current contact card and explicitly person-associated shared mailbox", () => {
	const result = verify(`${card}<footer>Copyright 2020</footer>`);
	expect(result?.name).toBe("Alex Smith");
	expect(result?.email).toBe("operations@example.test");
	expect(result?.id.length).toBe(64);
});

test("normalizes invisible Wix formatting and exact contiguous phone context", () => {
	expect(
		verify(card.replace("Smith", "Smith\u200b").replace("<p>", "<p>\u200b")),
	).not.toBeNull();
	expect(
		verify(card, {
			...candidate,
			associationQuote: "Alex Smith Operations Manager operations@example.test",
		}),
	).toBeNull();
});

test("does not associate a team name with a separate footer mailbox", () => {
	const html =
		"<main><section><h2>Alex Smith</h2><p>Operations Manager</p></section></main><footer>operations@example.test</footer>";
	expect(
		verify(html, {
			...candidate,
			associationQuote: "Alex Smith Operations Manager operations@example.test",
		}),
	).toBeNull();
});

test("rejects customer testimonials, old policies and former employees", () => {
	expect(verify(`<div class="testimonials">${card}</div>`)).toBeNull();
	expect(verify(`<blockquote>${card}</blockquote>`)).toBeNull();
	expect(
		verify(card, candidate, "https://example.test/2017-policy"),
	).toBeNull();
	expect(
		verify(card.replace("Operations Manager", "Former Operations Manager"), {
			...candidate,
			roleTitle: "Former Operations Manager",
			associationQuote: candidate.associationQuote.replace(
				"Operations Manager",
				"Former Operations Manager",
			),
		}),
	).toBeNull();
});

test("rejects an irrelevant title mislabeled as an operational role", () => {
	const wrong = {
		...candidate,
		roleTitle: "HR Manager",
		associationQuote: candidate.associationQuote.replace(
			"Operations Manager",
			"HR Manager",
		),
		employmentQuote: "Alex Smith HR Manager",
	};
	expect(
		verify(card.replace("Operations Manager", "HR Manager"), wrong),
	).toBeNull();
});

test("rejects another organization role mailbox and unofficial redirects", () => {
	const wrong = {
		...candidate,
		email: "alex@association.test",
		associationQuote: candidate.associationQuote.replace(
			"operations@example.test",
			"alex@association.test",
		),
	};
	expect(
		verify(
			card.replaceAll("operations@example.test", "alex@association.test"),
			wrong,
		),
	).toBeNull();
	expect(verify(card, candidate, "https://other.test/contact")).toBeNull();
});

test("keeps a name without email as research-only evidence", () => {
	const note = {
		...candidate,
		email: null,
		associationQuote: "Alex Smith Operations Manager",
	};
	expect(
		verify("<div><h2>Alex Smith</h2><p>Operations Manager</p></div>", note)
			?.email,
	).toBeNull();
});

test("verifies a generic published inbox without inventing a person's association", () => {
	const value = contactResearchCandidateSchema.parse({
		kind: "department",
		name: null,
		role: "department",
		roleTitle: "Published company inbox",
		email: "operations@example.test",
		sourceUrl: candidate.sourceUrl,
		associationQuote: "operations@example.test",
		employmentQuote: "operations@example.test",
	});
	expect(
		verify(
			'<footer><a href="mailto:operations@example.test">Email us</a></footer>',
			value,
		)?.kind,
	).toBe("department");
	expect(verify("<script>operations@example.test</script>", value)).toBeNull();
	expect(
		verify("<span hidden>operations@example.test</span>", value),
	).toBeNull();
	const encoded = Buffer.from([
		42,
		...Buffer.from(value.email ?? "").map((byte) => byte ^ 42),
	]).toString("hex");
	expect(
		verify(`<span data-cfemail="${encoded}">[email protected]</span>`, value)
			?.email,
	).toBe(value.email);
});

test("a different organization's published role mailbox cannot become a department fallback", () => {
	const value = contactResearchCandidateSchema.parse({
		kind: "department",
		name: null,
		role: "department",
		roleTitle: "Published company inbox",
		email: "president@association.test",
		sourceUrl: candidate.sourceUrl,
		associationQuote: "president@association.test",
		employmentQuote: "president@association.test",
	});
	expect(
		verify("<footer>president@association.test</footer>", value),
	).toBeNull();
});

test("rejects greeting and title control characters before verification", () => {
	expect(
		contactResearchCandidateSchema.safeParse({
			...candidate,
			name: "Alex\nBcc: other",
		}).success,
	).toBe(false);
	expect(
		contactResearchCandidateSchema.safeParse({
			...candidate,
			roleTitle: "Operations\nManager",
		}).success,
	).toBe(false);
});
