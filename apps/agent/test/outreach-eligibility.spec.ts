import { expect, test } from "bun:test";
import { isExplicitFleetRequest } from "../agent/lib/outreach-eligibility";

test("ordinary email and publication are not consent", () => {
	expect(
		isExplicitFleetRequest("Our fleet manager is available at this address."),
	).toBe(false);
	expect(isExplicitFleetRequest("Please email our invoice.")).toBe(false);
	expect(
		isExplicitFleetRequest(
			"I am not interested in Geotab. Please email no more.",
		),
	).toBe(false);
});
test("recognises a direct fleet contact request", () => {
	expect(isExplicitFleetRequest("Please contact me about Geotab.")).toBe(true);
	expect(
		isExplicitFleetRequest("We would like a demo of your vehicle tracking."),
	).toBe(true);
});
