import { type Db, Prisma } from "@crm/db";
import { evidenceSchema, OUTREACH } from "@crm/validation/outreach";
import {
	importCandidatesInput,
	importCandidatesOutput,
	OUTREACH_INTAKE,
	reviseSourceQuoteInput,
	reviseSourceQuoteOutput,
} from "@crm/validation/outreach-intake";
import { BadRequestException, Injectable } from "@nestjs/common";
import { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { OutreachService } from "./outreach.service";

@Injectable()
export class OutreachIntakeService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly outreach: OutreachService,
	) {}

	async importCandidates(
		userId: string,
		input: z.infer<typeof importCandidatesInput>,
	) {
		await this.outreach.assertOwner(userId);
		const candidates = importCandidatesInput.parse(input).prospects;
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
			const campaign = await tx.outreachCampaign.findUnique({
				where: { id: OUTREACH.id },
			});
			if (!campaign || campaign.ownerId !== userId)
				throw new BadRequestException(
					"Create the paused Geotab campaign before importing candidates.",
				);
			const rows: z.infer<typeof importCandidatesOutput>["rows"] = [];
			for (const candidate of candidates) {
				const where = {
					OR: [
						{
							domain: {
								equals: candidate.domain,
								mode: Prisma.QueryMode.insensitive,
							},
						},
						...(candidate.email
							? [
									{
										email: {
											equals: candidate.email,
											mode: Prisma.QueryMode.insensitive,
										},
									},
								]
							: []),
					],
				};
				let row = await tx.outreachProspect.findFirst({
					where,
					select: { id: true },
				});
				let queued = false;
				if (!row) {
					const evidence = evidenceSchema.parse({
						...candidate,
						checkedAt: new Date().toISOString(),
						verified: false,
					});
					const created = await tx.outreachProspect.createMany({
						data: [
							{
								campaignId: campaign.id,
								domain: candidate.domain,
								email: candidate.email,
								evidence,
								status: "HELD",
								manual: false,
								stopReason: OUTREACH_INTAKE.pendingReason,
								sourceVerificationDueAt: new Date(),
							},
						],
						skipDuplicates: true,
					});
					queued = created.count === 1;
					row = await tx.outreachProspect.findFirst({
						where,
						select: { id: true },
					});
				}
				if (!row)
					throw new BadRequestException(
						"Candidate import could not be confirmed. Retry the same manifest.",
					);
				rows.push({
					id: row.id,
					company: candidate.company,
					domain: candidate.domain,
					status: queued ? "queued" : "duplicate",
				});
			}
			return importCandidatesOutput.parse({
				queued: rows.filter((row) => row.status === "queued").length,
				duplicates: rows.filter((row) => row.status === "duplicate").length,
				rows,
			});
		});
	}

	async reviseSourceQuote(
		userId: string,
		input: z.infer<typeof reviseSourceQuoteInput>,
	) {
		await this.outreach.assertOwner(userId);
		const { id, sourceQuote } = reviseSourceQuoteInput.parse(input);
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${id} FOR UPDATE`;
			const campaign = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id, ownerId: userId },
			});
			const prospect = await tx.outreachProspect.findUniqueOrThrow({
				where: { id, campaignId: campaign.id },
			});
			const now = new Date();
			if (
				prospect.initialSentAt ||
				prospect.stoppedAt ||
				!["READY", "MANUAL"].includes(prospect.status) ||
				(prospect.sourceVerificationLeaseUntil &&
					prospect.sourceVerificationLeaseUntil >= now) ||
				(prospect.emailDraftLeaseUntil &&
					prospect.emailDraftLeaseUntil >= now) ||
				(await tx.outreachDelivery.count({ where: { prospectId: id } }))
			)
				throw new BadRequestException(
					"Only unsent eligible prospects without a stop, delivery or active verification or draft lease can revise a source quote.",
				);
			const evidence = evidenceSchema
				.catchall(z.json())
				.parse(prospect.evidence);
			if (
				!prospect.email ||
				evidence.domain !== prospect.domain ||
				evidence.email !== prospect.email
			)
				throw new BadRequestException(
					"The existing source record must match this prospect's company domain and recipient.",
				);
			if (
				(await tx.outreachSuppression.findUnique({
					where: { email: prospect.email },
				})) ||
				(await tx.suppressedContact.findUnique({
					where: { email: prospect.email },
				})) ||
				(await tx.suppressedDomain.findFirst({
					where: {
						domain: {
							in: [
								prospect.domain,
								prospect.email.split("@")[1] ?? prospect.domain,
							],
						},
					},
				}))
			)
				throw new BadRequestException("This address is suppressed.");
			await tx.outreachCampaign.update({
				where: { id: campaign.id },
				data: { status: "PAUSED" },
			});
			await tx.outreachProspect.update({
				where: { id },
				data: {
					evidence: { ...evidence, sourceQuote, verified: false },
					stopReason: OUTREACH_INTAKE.revisionReason,
					sourceVerificationAttempts: 0,
					sourceVerificationDueAt: now,
					sourceVerificationLease: null,
					sourceVerificationLeaseUntil: null,
					emailDrafts: Prisma.DbNull,
					emailDraftHash: null,
					emailDraftStatus: "PENDING",
					emailDraftAttempts: 0,
					emailDraftDueAt: now,
					emailDraftLease: null,
					emailDraftLeaseUntil: null,
					emailDraftError: null,
					emailDraftModel: null,
					emailDraftGeneratedAt: null,
					emailDraftReviewedHash: null,
					emailDraftReviewedAt: null,
				},
			});
		});
		return reviseSourceQuoteOutput.parse({ ok: true });
	}
}
