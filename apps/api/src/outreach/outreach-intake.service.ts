import { type Db, Prisma } from "@crm/db";
import { evidenceSchema, OUTREACH } from "@crm/validation/outreach";
import {
	importCandidatesInput,
	importCandidatesOutput,
	OUTREACH_INTAKE,
} from "@crm/validation/outreach-intake";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { z } from "zod";
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
}
