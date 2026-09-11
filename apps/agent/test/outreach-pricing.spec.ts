import { expect, test } from "bun:test";
import { catalogSchema } from "../agent/lib/outreach-replies";

test("reply price catalog accepts embedding models without output pricing", () => {
	const catalog = catalogSchema.parse({
		data: [
			{ id: "embedding", pricing: { input: "0.0000001" } },
			{ id: "reply", pricing: { input: "0.00000075", output: "0.0000045" } },
		],
	});
	expect(
		catalog.data.find((entry) => entry.id === "reply")?.pricing?.output,
	).toBe(0.0000045);
	expect(catalog.data[0]?.pricing?.output).toBeUndefined();
});
