import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEFAULT_TEMPLATES, OUTREACH } from "../src/outreach";
import {
	campaignHash,
	currentDraft,
	draftInputHash,
	draftReviewHash,
} from "../src/outreach-draft-state";
import {
	DRAFTING,
	draftArtifactSchema,
	PERSONALISATION,
} from "../src/outreach-drafts";
import legacy from "./fixtures/outreach-draft-legacy.json";

describe("review model artifact compatibility", () => {
	test("the frozen legacy artifact keeps its exact bytes but the new workflow invalidates its approval", () => {
		const expectedReviewHash =
			"ae69373efa7b6e00de2169e350464796caf0729e5f5e69f0d4b4b5a949240be9";
		expect(legacy.sourceCommit).toBe(
			"9a9d43f5a0811e888e0f8c7243cdb760b02cd49c",
		);
		expect(DEFAULT_TEMPLATES).toEqual(legacy.templates);
		expect(DRAFTING.model).toBe("openai/gpt-5.4-mini");
		expect(PERSONALISATION.version).toBe("contact-grounded-v2");
		const parsed = draftArtifactSchema.parse(legacy.prospect.emailDrafts);
		expect(Object.hasOwn(parsed, "reviewModel")).toBe(false);
		expect(JSON.stringify(parsed)).toBe(
			JSON.stringify(legacy.prospect.emailDrafts),
		);
		expect(
			createHash("sha256")
				.update(
					JSON.stringify({
						templates: DEFAULT_TEMPLATES,
						rules: OUTREACH,
						personalisation: PERSONALISATION,
					}),
				)
				.digest("hex"),
		).toBe(legacy.prospect.emailDrafts.campaignHash);
		expect(campaignHash(DEFAULT_TEMPLATES)).not.toBe(
			legacy.prospect.emailDrafts.campaignHash,
		);
		expect(draftInputHash(legacy.prospect, DEFAULT_TEMPLATES)).not.toBe(
			legacy.prospect.emailDraftHash,
		);
		expect(legacy.reviewHash).toBe(expectedReviewHash);
		expect(draftReviewHash(parsed)).toBe(expectedReviewHash);
		const current = currentDraft(legacy.prospect, DEFAULT_TEMPLATES);
		expect(current).toBeNull();
	});

	test.each(["openai/gpt-5.4-mini", "openai/gpt-5.4-mini-fast"])(
		"explicit %s review provenance stays distinct and requires current workflow hashes",
		(reviewModel) => {
			const artifact = draftArtifactSchema.parse({
				...legacy.prospect.emailDrafts,
				reviewModel,
			});
			expect(artifact.reviewModel).toBe(reviewModel);
			expect(Object.keys(artifact).at(-1)).toBe("reviewModel");
			expect(artifact.stages).toEqual(legacy.prospect.emailDrafts.stages);
			expect(artifact.inputHash).toBe(legacy.prospect.emailDraftHash);
			expect(draftReviewHash(artifact)).not.toBe(legacy.reviewHash);
			expect(
				currentDraft(
					{ ...legacy.prospect, emailDrafts: artifact },
					DEFAULT_TEMPLATES,
				),
			).toBeNull();
			const inputHash = draftInputHash(legacy.prospect, DEFAULT_TEMPLATES);
			const renewed = draftArtifactSchema.parse({
				...artifact,
				campaignHash: campaignHash(DEFAULT_TEMPLATES),
				inputHash,
			});
			const current = currentDraft(
				{ ...legacy.prospect, emailDraftHash: inputHash, emailDrafts: renewed },
				DEFAULT_TEMPLATES,
			);
			expect(current).toEqual(renewed);
			expect(current).not.toBeNull();
			if (!current)
				throw new Error("Expected current draft with review provenance");
			expect(draftReviewHash(current)).toBe(draftReviewHash(renewed));
			expect(draftReviewHash(current)).not.toBe(draftReviewHash(artifact));
			expect(JSON.stringify(current.stages)).toBe(
				JSON.stringify(legacy.prospect.emailDrafts.stages),
			);
		},
	);

	test("changing only the review model changes the approval hash", () => {
		const currentWorkflow = {
			...legacy.prospect.emailDrafts,
			campaignHash: campaignHash(DEFAULT_TEMPLATES),
			inputHash: draftInputHash(legacy.prospect, DEFAULT_TEMPLATES),
		};
		const mini = draftArtifactSchema.parse({
			...currentWorkflow,
			reviewModel: DRAFTING.model,
		});
		const fast = draftArtifactSchema.parse({
			...currentWorkflow,
			reviewModel: DRAFTING.reviewModel,
		});
		expect(draftReviewHash(mini)).not.toBe(draftReviewHash(fast));
		expect(mini.inputHash).toBe(fast.inputHash);
		expect(mini.campaignHash).toBe(fast.campaignHash);
		expect(mini.stages).toEqual(fast.stages);
		expect(draftInputHash(legacy.prospect, DEFAULT_TEMPLATES)).toBe(
			fast.inputHash,
		);
	});

	test.each(["openai/gpt-5.4", "unsupported/provider", null, ""])(
		"rejects unsupported review provenance %s",
		(reviewModel) => {
			const artifact = { ...legacy.prospect.emailDrafts, reviewModel };
			expect(draftArtifactSchema.safeParse(artifact).success).toBe(false);
			expect(
				currentDraft(
					{ ...legacy.prospect, emailDrafts: artifact },
					DEFAULT_TEMPLATES,
				),
			).toBeNull();
		},
	);
});
