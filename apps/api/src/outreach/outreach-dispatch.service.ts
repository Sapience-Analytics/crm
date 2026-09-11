import { randomUUID } from "node:crypto";
import type {
	Db,
	OutreachCampaignModel,
	OutreachDeliveryModel,
	OutreachProspectModel,
} from "@crm/db";
import { Prisma } from "@crm/db";
import {
	consentSchema,
	contactEligible,
	evidenceSchema,
	followupDue,
	OUTREACH,
	perthDay,
	readinessSchema,
	renderEmail,
	sendWindow,
	stopReason,
	templatesSchema,
	weekStart,
} from "@crm/validation/outreach";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { header, plainTextBody } from "../google/gmail-mime";
import { GmailSyncService } from "../google/gmail-sync.service";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import { stripQuotedHistory } from "../mailbox/message-text";
import { ThreadWriterService } from "../mailbox/thread-writer.service";
import { campaignHash } from "./outreach.service";
import { OutreachGmail } from "./outreach-gmail";

@Injectable()
export class OutreachDispatchService {
	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly tokens: MailboxTokenService,
		private readonly gmail: OutreachGmail,
		private readonly parser: GmailSyncService,
		private readonly writer: ThreadWriterService,
	) {}

	async run() {
		if (process.env.VERCEL_ENV !== "production")
			return { status: "disabled-outside-production" };
		const now = new Date();
		const lease = randomUUID();
		const claimed = await this.db.outreachCampaign.updateMany({
			where: {
				id: OUTREACH.id,
				OR: [{ sendLeaseUntil: null }, { sendLeaseUntil: { lt: now } }],
			},
			data: {
				sendLease: lease,
				sendLeaseUntil: new Date(now.getTime() + OUTREACH.leaseMs),
				lastTickAt: now,
			},
		});
		if (!claimed.count) return { status: "idle" };
		try {
			const campaign = await this.db.outreachCampaign.findUniqueOrThrow({
				where: { id: OUTREACH.id },
			});
			await this.report(campaign);
			const token = await this.tokens.accessTokenFor(campaign.ownerId, "gmail");
			if (token.outcome !== "ok") throw new Error(token.reason);
			if (
				(await this.gmail.profile(token.accessToken)) !== campaign.senderEmail
			)
				throw new Error("Gmail sender does not match campaign owner.");
			await this.reconcile(campaign, token.accessToken);
			const uncertain = await this.db.outreachDelivery.count({
				where: { status: { in: ["UNKNOWN", "SENDING"] } },
			});
			if (uncertain > 0)
				throw new Error(
					`${uncertain} uncertain deliveries require reconciliation. Sending is held.`,
				);
			const monitor = await this.db.outreachProspect.findMany({
				where: {
					campaignId: campaign.id,
					manual: false,
					initialSentAt: { not: null },
					status: { in: ["ACTIVE", "COMPLETE"] },
				},
				orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }],
				take: 5,
			});
			for (const prospect of monitor)
				await this.inspect(campaign, prospect, token.accessToken);
			if (!sendWindow(now) || !["PILOT", "ACTIVE"].includes(campaign.status))
				return { status: "monitoring" };
			if (!readinessSchema.safeParse(campaign.readiness).success)
				throw new Error("Launch checks are incomplete.");
			if (
				campaign.approvedHash !==
				campaignHash(templatesSchema.parse(campaign.templates))
			)
				throw new Error("Current campaign templates are not approved.");
			const scopes = await this.tokens.grantedScopes(
				campaign.ownerId,
				"google",
			);
			if (!scopes.has("https://www.googleapis.com/auth/gmail.send"))
				throw new Error("Reconnect Gmail with sending permission.");
			const next = await this.db.outreachProspect.findFirst({
				where: {
					campaignId: campaign.id,
					manual: false,
					status: { in: ["READY", "ACTIVE"] },
					nextDueAt: { lte: now },
					pilotSlot: campaign.status === "PILOT" ? { not: null } : undefined,
				},
				orderBy: [{ nextDueAt: "asc" }, { createdAt: "asc" }],
			});
			if (next) await this.deliver(campaign, next, token.accessToken, lease);
			await this.db.outreachCampaign.updateMany({
				where: { id: campaign.id, sendLease: lease },
				data: { lastError: null },
			});
			return { status: "checked" };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Outreach dispatch failed";
			await this.db.outreachCampaign.updateMany({
				where: { id: OUTREACH.id, sendLease: lease },
				data: { lastError: message },
			});
			return { status: "held", reason: message };
		} finally {
			await this.db.outreachCampaign.updateMany({
				where: { id: OUTREACH.id, sendLease: lease },
				data: { sendLease: null, sendLeaseUntil: null },
			});
		}
	}

	private async inspect(
		campaign: OutreachCampaignModel,
		prospect: OutreachProspectModel,
		token: string,
	) {
		if (!prospect.email || prospect.manual) return false;
		const suppressed = await this.db.outreachSuppression.findUnique({
			where: { email: prospect.email },
		});
		const crmSuppressed = await this.db.suppressedContact.findUnique({
			where: { email: prospect.email },
		});
		const domainSuppressed = await this.db.suppressedDomain.findUnique({
			where: { domain: prospect.domain },
		});
		if (suppressed || crmSuppressed || domainSuppressed) {
			await this.stop(
				prospect,
				"SUPPRESSED",
				"Address or domain is suppressed",
				null,
			);
			return false;
		}
		const calendar = await this.db.mailboxSync.findUnique({
			where: {
				userId_source: { userId: campaign.ownerId, source: "calendar" },
			},
		});
		if (
			!calendar?.lastSyncedAt ||
			Date.now() - calendar.lastSyncedAt.getTime() > OUTREACH.leaseMs * 3
		)
			throw new Error("Calendar sync is stale. Sending is held.");
		const booking = await this.db.calendarAttendee.findFirst({
			where: {
				email: { equals: prospect.email, mode: "insensitive" },
				event: {
					syncedByUserId: campaign.ownerId,
					status: { not: "cancelled" },
					startsAt: { gte: prospect.createdAt },
				},
			},
		});
		if (booking) {
			await this.stop(
				prospect,
				"BOOKED",
				"A matching meeting is recorded",
				null,
			);
			return false;
		}
		const after = Math.floor(
			(prospect.initialSentAt ?? prospect.createdAt).getTime() / 1000,
		);
		const found = await this.gmail.search(
			token,
			`in:anywhere after:${after} {from:${prospect.email} "${prospect.email}"}`,
		);
		const ours = await this.db.outreachDelivery.findMany({
			where: { prospectId: prospect.id },
			select: { gmailMessageId: true, gmailThreadId: true },
		});
		const allIds = new Set(found.map((row) => row.id));
		for (const threadId of new Set(
			ours.flatMap((row) => (row.gmailThreadId ? [row.gmailThreadId] : [])),
		)) {
			for (const message of await this.gmail.threadIds(token, threadId))
				allIds.add(message.id);
		}
		const known = new Set(ours.map((row) => row.gmailMessageId));
		for (const id of allIds) {
			if (known.has(id)) continue;
			const message = await this.gmail.message(token, id);
			const from = header(message.payload?.headers, "from") ?? "";
			const subject = header(message.payload?.headers, "subject") ?? "";
			const body = stripQuotedHistory(plainTextBody(message.payload));
			if (message.labelIds?.includes("SENT")) {
				await this.stop(
					prospect,
					"REPLIED",
					"A manual outbound email exists. Automation is paused.",
					null,
				);
				return false;
			}
			const status = stopReason(from, `${subject}\n${body}`);
			await this.stop(
				prospect,
				status,
				"A new mailbox message requires attention",
				body.slice(0, 8000),
			);
			return false;
		}
		await this.db.outreachProspect.update({
			where: { id: prospect.id },
			data: { lastCheckedAt: new Date() },
		});
		return true;
	}

	private async stop(
		prospect: OutreachProspectModel,
		status: string,
		reason: string,
		reply: string | null,
	) {
		await this.db.$transaction(async (tx) => {
			await tx.outreachProspect.update({
				where: { id: prospect.id },
				data: {
					status,
					stoppedAt: new Date(),
					stopReason: reason,
					replyText: reply,
					lastCheckedAt: new Date(),
				},
			});
			if (prospect.email && ["BOUNCED", "SUPPRESSED"].includes(status))
				await tx.outreachSuppression.upsert({
					where: { email: prospect.email },
					update: { reason: status },
					create: { email: prospect.email, reason: status },
				});
		});
	}

	private async deliver(
		campaign: OutreachCampaignModel,
		prospect: OutreachProspectModel,
		token: string,
		lease: string,
	) {
		const evidence = evidenceSchema.parse(prospect.evidence);
		const consent = consentSchema.safeParse(prospect.consent);
		if (
			!contactEligible(evidence, consent.success ? consent.data : null) ||
			!prospect.email ||
			prospect.manual
		)
			return;
		if (!(await this.inspect(campaign, prospect, token))) return;
		const prior = await this.db.outreachDelivery.findUnique({
			where: { prospectId_stage: { prospectId: prospect.id, stage: 0 } },
		});
		if (
			prospect.nextStage > 0 &&
			(!prior?.gmailThreadId || !prospect.initialSentAt)
		)
			throw new Error("Initial delivery is not reconciled.");
		const templates = templatesSchema.parse(campaign.templates);
		const content = renderEmail(templates, evidence, prospect.nextStage);
		const now = new Date();
		const dayStart = new Date(`${perthDay(now)}T00:00:00+08:00`);
		const delivery = await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${campaign.id} FOR UPDATE`;
			const current = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: campaign.id },
			});
			const target = await tx.outreachProspect.findUniqueOrThrow({
				where: { id: prospect.id },
			});
			if (
				current.sendLease !== lease ||
				!current.sendLeaseUntil ||
				current.sendLeaseUntil <= now ||
				!sendWindow(now) ||
				!["PILOT", "ACTIVE"].includes(current.status) ||
				current.approvedHash !== campaign.approvedHash ||
				target.manual ||
				!["READY", "ACTIVE"].includes(target.status) ||
				target.nextStage !== prospect.nextStage
			)
				return null;
			const total = await tx.outreachDelivery.count({
				where: { createdAt: { gte: dayStart } },
			});
			const initials = await tx.outreachDelivery.count({
				where: { stage: 0, createdAt: { gte: dayStart } },
			});
			if (
				total >= OUTREACH.dailyTotal ||
				(prospect.nextStage === 0 && initials >= OUTREACH.dailyInitial)
			)
				return null;
			if (
				await tx.outreachDelivery.findUnique({
					where: {
						prospectId_stage: {
							prospectId: prospect.id,
							stage: prospect.nextStage,
						},
					},
				})
			)
				return null;
			return tx.outreachDelivery.create({
				data: {
					prospectId: prospect.id,
					stage: prospect.nextStage,
					rfcMessageId: `${randomUUID()}@sapienceanalytics.com.au`,
					subject: content.subject,
					body: content.body,
					approvalHash: campaign.approvedHash ?? "",
				},
			});
		});
		if (!delivery) return;
		try {
			const sent = await this.gmail.send(token, {
				...content,
				to: prospect.email,
				from: campaign.senderEmail,
				rfcId: delivery.rfcMessageId,
				rootId: prior?.rfcMessageId,
				threadId: prior?.gmailThreadId ?? undefined,
			});
			await this.finish(delivery, sent.id, sent.threadId, new Date());
			await this.log(campaign, delivery.id, token);
		} catch (error) {
			await this.db.outreachDelivery.updateMany({
				where: { id: delivery.id, status: "SENDING" },
				data: {
					status: "UNKNOWN",
					lastError: "Delivery outcome is uncertain. Do not retry.",
				},
			});
			throw error;
		}
	}

	private async finish(
		delivery: OutreachDeliveryModel,
		gmailMessageId: string,
		gmailThreadId: string,
		sentAt: Date,
	) {
		await this.db.$transaction(async (tx) => {
			await tx.outreachDelivery.update({
				where: { id: delivery.id },
				data: {
					status: "SENT",
					gmailMessageId,
					gmailThreadId,
					sentAt,
					lastError: null,
				},
			});
			const prospect = await tx.outreachProspect.findUniqueOrThrow({
				where: { id: delivery.prospectId },
			});
			const initial = prospect.initialSentAt ?? sentAt;
			await tx.outreachProspect.updateMany({
				where: {
					id: prospect.id,
					manual: false,
					status: { in: ["READY", "ACTIVE"] },
				},
				data: {
					initialSentAt: initial,
					nextStage: delivery.stage + 1,
					status: delivery.stage === 2 ? "COMPLETE" : "ACTIVE",
					nextDueAt:
						delivery.stage === 2
							? sentAt
							: followupDue(initial, delivery.stage + 1),
				},
			});
		});
	}

	private async reconcile(campaign: OutreachCampaignModel, token: string) {
		const rows = await this.db.outreachDelivery.findMany({
			where: {
				prospect: { campaignId: campaign.id },
				OR: [
					{ status: "UNKNOWN" },
					{
						status: "SENDING",
						createdAt: { lt: new Date(Date.now() - OUTREACH.leaseMs) },
					},
					{ status: "SENT", loggedAt: null },
				],
			},
			take: 5,
		});
		for (const row of rows) {
			if (row.status !== "SENT") {
				const result = await this.gmail.search(
					token,
					`in:sent rfc822msgid:${row.rfcMessageId}`,
				);
				const found = result[0];
				if (result.length !== 1 || !found) {
					await this.db.outreachDelivery.update({
						where: { id: row.id },
						data: {
							status: "UNKNOWN",
							lastError:
								"No unique sent message found. Owner review required; no automatic retry.",
						},
					});
					continue;
				}
				const message = await this.gmail.message(token, found.id);
				const sentAt = new Date(Number(message.internalDate));
				if (!Number.isFinite(sentAt.getTime()))
					throw new Error("Sent message timestamp is unavailable.");
				await this.finish(row, found.id, found.threadId, sentAt);
			}
			await this.log(campaign, row.id, token);
		}
	}

	private async log(
		campaign: OutreachCampaignModel,
		deliveryId: string,
		token: string,
	) {
		const delivery = await this.db.outreachDelivery.findUniqueOrThrow({
			where: { id: deliveryId },
		});
		if (!delivery.gmailMessageId || delivery.loggedAt) return;
		const message = await this.gmail.message(token, delivery.gmailMessageId);
		const parsed = this.parser.parse(message);
		if (!parsed)
			throw new Error("Sent email could not be parsed for CRM logging.");
		const mailbox = await this.db.mailboxSync.findUniqueOrThrow({
			where: { userId_source: { userId: campaign.ownerId, source: "gmail" } },
		});
		await this.writer.store(
			mailbox,
			{ mailbox: campaign.senderEmail, origin: "gmail" },
			parsed,
			await this.writer.context(),
		);
		await this.db.outreachDelivery.update({
			where: { id: delivery.id },
			data: { loggedAt: new Date() },
		});
	}

	private async report(campaign: OutreachCampaignModel) {
		const end = weekStart(new Date());
		const start = new Date(end.getTime() - OUTREACH.dayMs * 7);
		if (campaign.createdAt >= end) return;
		const id = `${campaign.id}:${perthDay(start)}`;
		if (await this.db.outreachReport.findUnique({ where: { id } })) return;
		const [researched, sent, replies, meetings, held, budgets, eligible] =
			await Promise.all([
				this.db.outreachProspect.count({
					where: { createdAt: { gte: start, lt: end } },
				}),
				this.db.outreachDelivery.count({
					where: { status: "SENT", sentAt: { gte: start, lt: end } },
				}),
				this.db.outreachProspect.count({
					where: { status: "REPLIED", stoppedAt: { gte: start, lt: end } },
				}),
				this.db.outreachProspect.count({
					where: { status: "BOOKED", stoppedAt: { gte: start, lt: end } },
				}),
				this.db.outreachProspect.count({ where: { status: "HELD" } }),
				this.db.outreachBudget.findMany({
					where: { id: { contains: start.toISOString().slice(0, 7) } },
					select: { id: true, reservedMicroUsd: true, actualMicroUsd: true },
				}),
				this.db.outreachProspect.count({
					where: {
						createdAt: { gte: start, lt: end },
						consent: { not: Prisma.DbNull },
					},
				}),
			]);
		await this.db.outreachReport.upsert({
			where: { id },
			update: {},
			create: {
				id,
				campaignId: campaign.id,
				week: start,
				summary: {
					researched,
					eligible,
					sent,
					replies,
					meetings,
					held,
					monthlyCostsAtReportTime: budgets,
				},
			},
		});
	}
}
