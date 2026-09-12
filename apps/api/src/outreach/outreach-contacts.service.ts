import { type Db, Prisma } from "@crm/db";
import { evidenceSchema, OUTREACH } from "@crm/validation/outreach";
import { contactResearchInputHash } from "@crm/validation/outreach-contact-state";
import { contactTargetSchema } from "@crm/validation/outreach-contact-target";
import {
	CONTACT_RESEARCH,
	contactResearchActionOutput,
	contactResearchInput,
	contactResearchOutput,
	queueContactResearchInput,
	selectContactInput,
} from "@crm/validation/outreach-contacts";
import { BadRequestException, Injectable } from "@nestjs/common";
import { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { OutreachService } from "./outreach.service";

@Injectable()
export class OutreachContactsService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly outreach: OutreachService,
	) {}

	async status(userId: string, input: z.infer<typeof contactResearchInput>) {
		await this.outreach.assertOwner(userId);
		const { id } = contactResearchInput.parse(input);
		const prospect = await this.db.outreachProspect.findUniqueOrThrow({
			where: { id, campaignId: OUTREACH.id, campaign: { ownerId: userId } },
		});
		const job = await this.db.outreachContactResearch.findUnique({
			where: { prospectId: id },
		});
		if (!job)
			return contactResearchOutput.parse({
				status: "NOT_STARTED",
				error: null,
				completedAt: null,
				candidates: [],
			});
		const stale =
			job.status === "READY" &&
			(job.inputHash !== contactResearchInputHash(prospect) ||
				!job.completedAt ||
				job.completedAt.getTime() > Date.now() ||
				Date.now() - job.completedAt.getTime() >
					CONTACT_RESEARCH.candidateFreshMs);
		return contactResearchOutput.parse({
			status: stale ? "STALE" : job.status,
			error: stale
				? "Contact research is stale. Run research again."
				: job.error,
			completedAt: job.completedAt?.toISOString() ?? null,
			candidates: job.candidates ?? [],
		});
	}

	async research(
		userId: string,
		input: z.infer<typeof queueContactResearchInput>,
	) {
		await this.outreach.assertOwner(userId);
		const { id, candidates } = queueContactResearchInput.parse(input);
		await this.db.$transaction(async (tx) => {
			const { prospect, now } = await this.lockedProspect(tx, userId, id);
			await tx.outreachCampaign.update({
				where: { id: OUTREACH.id },
				data: { status: "PAUSED" },
			});
			const data = {
				status: "PENDING",
				inputHash: contactResearchInputHash(prospect),
				dueAt: now,
				attempts: 0,
				lease: null,
				leaseUntil: null,
				candidates: Prisma.DbNull,
				submittedCandidates: candidates ?? Prisma.DbNull,
				error: null,
				completedAt: null,
			};
			await tx.outreachContactResearch.upsert({
				where: { prospectId: id },
				create: { prospectId: id, ...data },
				update: data,
			});
		});
		return contactResearchActionOutput.parse({ ok: true });
	}

	async select(userId: string, input: z.infer<typeof selectContactInput>) {
		await this.outreach.assertOwner(userId);
		const { id, candidateId } = selectContactInput.parse(input);
		await this.db.$transaction(async (tx) => {
			const { prospect, evidence, job, now } = await this.lockedProspect(
				tx,
				userId,
				id,
			);
			if (
				job?.status !== "READY" ||
				job.inputHash !== contactResearchInputHash(prospect) ||
				!job.completedAt ||
				job.completedAt > now ||
				now.getTime() - job.completedAt.getTime() >
					CONTACT_RESEARCH.candidateFreshMs
			)
				throw new BadRequestException(
					"Current completed contact research is required. Run research again.",
				);
			const candidates = contactResearchOutput.shape.candidates.parse(
				job.candidates,
			);
			const parsed = contactTargetSchema.safeParse(
				candidates.find((candidate) => candidate.id === candidateId),
			);
			if (!parsed.success || !parsed.data.email)
				throw new BadRequestException(
					"Select a verified candidate with a published work email from this research.",
				);
			const target = parsed.data;
			const email = parsed.data.email;
			const checkedAt = new Date(target.checkedAt);
			if (
				checkedAt > now ||
				now.getTime() - checkedAt.getTime() > CONTACT_RESEARCH.candidateFreshMs
			)
				throw new BadRequestException(
					"The selected contact evidence is stale. Run research again.",
				);
			await this.assertAvailable(tx, userId, prospect, email);
			const identityChanged = prospect.email !== email;
			await tx.outreachCampaign.update({
				where: { id: OUTREACH.id },
				data: { status: "PAUSED" },
			});
			await tx.outreachProspect.update({
				where: { id },
				data: {
					email,
					contactId: prospect.email === email ? prospect.contactId : null,
					evidence: {
						...evidence,
						email,
						contactTarget: target,
						contactSourceUrl: target.sourceUrl,
						contactRoleQuote: target.associationQuote,
						verified: false,
					},
					consent: identityChanged ? Prisma.DbNull : undefined,
					status: identityChanged ? "HELD" : prospect.status,
					stopReason: identityChanged
						? "Contact selection requires source verification and new contact qualification. Sending is paused."
						: "Contact evidence refresh requires source verification and new draft review. Sending is paused.",
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
			await tx.outreachContactResearch.update({
				where: { prospectId: id },
				data: { status: "SELECTED" },
			});
		});
		return contactResearchActionOutput.parse({ ok: true });
	}

	private async lockedProspect(
		tx: Prisma.TransactionClient,
		userId: string,
		id: string,
	) {
		await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${OUTREACH.id} FOR UPDATE`;
		await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${id} FOR UPDATE`;
		const campaign = await tx.outreachCampaign.findUniqueOrThrow({
			where: { id: OUTREACH.id, ownerId: userId },
		});
		const prospect = await tx.outreachProspect.findUniqueOrThrow({
			where: { id, campaignId: campaign.id },
		});
		const job = await tx.outreachContactResearch.findUnique({
			where: { prospectId: id },
		});
		const now = new Date();
		if (
			prospect.initialSentAt ||
			prospect.stoppedAt ||
			!["HELD", "READY", "MANUAL"].includes(prospect.status) ||
			[
				campaign.sendLeaseUntil,
				prospect.sourceVerificationLeaseUntil,
				prospect.emailDraftLeaseUntil,
				job?.leaseUntil,
			].some((until) => until && until >= now) ||
			(await tx.outreachDelivery.count({ where: { prospectId: id } }))
		)
			throw new BadRequestException(
				"Contact changes require an unsent prospect without a stop, delivery or active send, draft, source or contact research lease.",
			);
		const evidence = evidenceSchema.catchall(z.json()).parse(prospect.evidence);
		if (!prospect.companyId)
			throw new BadRequestException(
				"Verify the company source before researching or selecting contacts.",
			);
		if (
			evidence.domain !== prospect.domain ||
			evidence.email !== prospect.email
		)
			throw new BadRequestException(
				"The existing prospect identity is inconsistent.",
			);
		await this.assertAvailable(tx, userId, prospect, prospect.email);
		return { prospect, evidence, job, now };
	}

	private async assertAvailable(
		tx: Prisma.TransactionClient,
		userId: string,
		prospect: {
			id: string;
			domain: string;
			companyId: string | null;
			contactId: string | null;
			email: string | null;
		},
		email: string | null,
	) {
		const domains = [prospect.domain];
		if (email) domains.push(email.split("@")[1] ?? prospect.domain);
		if (
			(await tx.suppressedDomain.findFirst({
				where: { domain: { in: domains } },
			})) ||
			(email &&
				((await tx.outreachSuppression.findUnique({ where: { email } })) ||
					(await tx.suppressedContact.findUnique({ where: { email } }))))
		)
			throw new BadRequestException("This address or domain is suppressed.");
		if (prospect.companyId) {
			const company = await tx.company.findUnique({
				where: { id: prospect.companyId },
			});
			if (
				!company ||
				company.archivedAt ||
				company.ownerId !== userId ||
				company.domain !== prospect.domain
			)
				throw new BadRequestException(
					"The existing company binding is unavailable.",
				);
		}
		if (!email) return;
		if (
			await tx.outreachProspect.findFirst({
				where: {
					id: { not: prospect.id },
					email: { equals: email, mode: "insensitive" },
				},
			})
		)
			throw new BadRequestException("This email belongs to another prospect.");
		const contacts = await tx.contact.findMany({
			where: {
				OR: [
					{ email: { equals: email, mode: "insensitive" } },
					...(email === prospect.email && prospect.contactId
						? [{ id: prospect.contactId }]
						: []),
				],
			},
		});
		if (
			contacts.length > 1 ||
			(email === prospect.email &&
				prospect.contactId &&
				contacts.length === 0) ||
			contacts.some(
				(contact) =>
					contact.archivedAt ||
					contact.ownerId !== userId ||
					!prospect.companyId ||
					contact.companyId !== prospect.companyId ||
					contact.email?.toLowerCase() !== email,
			)
		)
			throw new BadRequestException(
				"This contact has a conflicting or archived CRM binding.",
			);
	}
}
