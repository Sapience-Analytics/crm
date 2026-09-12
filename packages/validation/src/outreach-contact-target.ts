import { z } from "zod";

export const contactResearchCandidateSchema = z
	.object({
		kind: z.enum(["named", "department"]),
		name: z
			.string()
			.trim()
			.min(3)
			.max(120)
			.regex(/^[\p{L}\p{M}][\p{L}\p{M} .'’-]+$/u)
			.nullable(),
		role: z.enum([
			"fleet",
			"transport",
			"operations",
			"owner",
			"managing-director",
			"branch-manager",
			"general-manager",
			"department",
		]),
		roleTitle: z
			.string()
			.trim()
			.min(3)
			.max(120)
			.regex(/^[\p{L}\p{M}\p{N} .,'’&()/–-]+$/u),
		email: z.email().toLowerCase().nullable(),
		sourceUrl: z.url().refine((url) => url.startsWith("https://")),
		associationQuote: z.string().trim().min(10).max(600),
		employmentQuote: z.string().trim().min(10).max(600),
	})
	.strict()
	.refine(
		(value) =>
			value.kind === "named"
				? value.name !== null && value.role !== "department"
				: value.name === null &&
					value.email !== null &&
					value.role === "department",
		"A named contact needs a verified person and role; a department needs a published inbox.",
	);

export const contactResearchResultSchema = z.object({
	candidates: z.array(contactResearchCandidateSchema).max(3),
});

export const verifiedContactCandidateSchema =
	contactResearchCandidateSchema.safeExtend({
		id: z.string().length(64),
		verified: z.literal(true),
		checkedAt: z.iso.datetime(),
	});

export const contactTargetSchema = verifiedContactCandidateSchema.refine(
	(value) => value.email !== null,
	"A selected contact needs an explicitly published work email.",
);

export type ContactResearchCandidate = z.infer<
	typeof contactResearchCandidateSchema
>;
export type VerifiedContactCandidate = z.infer<
	typeof verifiedContactCandidateSchema
>;
