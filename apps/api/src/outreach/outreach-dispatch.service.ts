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
	sendWindow,
	templatesSchema,
	weekStart,
} from "@crm/validation/outreach";
import {
	campaignHash,
	currentDraft,
	draftReviewHash,
} from "@crm/validation/outreach-draft-state";
import {
	type IncomingReferral,
	OUTREACH_AUTOMATION,
} from "@crm/validation/outreach-referrals";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { GmailSyncService } from "../google/gmail-sync.service";
import { MailboxTokenService } from "../mailbox/mailbox-token.service";
import { ThreadWriterService } from "../mailbox/thread-writer.service";
import { verifiedOutreachContact } from "./outreach-contact";
import { OutreachGmail } from "./outreach-gmail";
import { verifiedSentIdentity } from "./outreach-identity";
import { captureOutreachInbound } from "./outreach-inbound";
import {
	classifyOutreachMessage,
	storeOutreachMessage,
} from "./outreach-message";
import { pilotProgress } from "./outreach-pilot";

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
			let campaign = await this.db.outreachCampaign.findUniqueOrThrow({
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
					status: { in: ["ACTIVE", "COMPLETE", "REPLIED"] },
				},
				orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }],
				take: 5,
			});
			for (const prospect of monitor)
				await this.inspect(campaign, prospect, token.accessToken);
			campaign = await this.advancePilot(campaign);
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
			const candidates = await this.db.outreachProspect.findMany({
				where: {
					campaignId: campaign.id,
					manual: false,
					status: { in: ["READY", "ACTIVE"] },
					nextDueAt: { lte: now },
					OR:
						campaign.status === "PILOT"
							? [
									{ pilotSlot: { not: null } },
									{
										referralParent: { pilotSlot: { not: null }, manual: false },
									},
								]
							: undefined,
				},
				orderBy: [{ nextDueAt: "asc" }, { createdAt: "asc" }],
				take: 20,
			});
			let next: OutreachProspectModel | undefined;
			for (const candidate of candidates) {
				const draft = currentDraft(
					candidate,
					templatesSchema.parse(campaign.templates),
				);
				if (
					draft &&
					(candidate.pilotSlot === null ||
						candidate.emailDraftReviewedHash === draftReviewHash(draft))
				) {
					try {
						await verifiedOutreachContact(this.db, candidate, campaign.ownerId);
						next = candidate;
						break;
					} catch {
						await this.db.outreachProspect.updateMany({
							where: { id: candidate.id, status: { in: ["READY", "ACTIVE"] } },
							data: {
								stopReason:
									"Verified company/contact binding needs review before sending.",
							},
						});
					}
				}
				await this.db.outreachProspect.updateMany({
					where: { id: candidate.id, status: { in: ["READY", "ACTIVE"] } },
					data: { nextDueAt: new Date(now.getTime() + OUTREACH.minuteMs * 60) },
				});
			}
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
		if (prospect.referredFromId) {
			const parent = await this.db.outreachProspect.findUniqueOrThrow({
				where: { id: prospect.referredFromId },
			});
			await this.inspect(campaign, parent, token);
			const currentParent = await this.db.outreachProspect.findUniqueOrThrow({
				where: { id: parent.id },
			});
			if (
				currentParent.manual ||
				currentParent.status !== "REPLIED" ||
				currentParent.referralDepth >= OUTREACH_AUTOMATION.maxReferralDepth
			)
				return false;
		}
		const suppressed = await this.db.outreachSuppression.findUnique({
			where: { email: prospect.email },
		});
		const crmSuppressed = await this.db.suppressedContact.findUnique({
			where: { email: prospect.email },
		});
		const domainSuppressed = await this.db.suppressedDomain.findFirst({
			where: {
				domain: {
					in: [
						prospect.domain,
						prospect.email.split("@")[1] ?? prospect.domain,
					],
				},
			},
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
		const recorded = await this.db.outreachInbound.findMany({
			where: { prospectId: prospect.id },
			select: { messageId: true },
		});
		for (const row of recorded) known.add(row.messageId);
		const threadIds = new Set(
			ours.flatMap((row) => (row.gmailThreadId ? [row.gmailThreadId] : [])),
		);
		for (const id of allIds) {
			if (known.has(id)) continue;
			const message = await this.gmail.message(token, id);
			const { status, body } = classifyOutreachMessage(message);
			const incoming = captureOutreachInbound(
				message,
				body.slice(0, OUTREACH_AUTOMATION.referralMaxBodyChars),
				threadIds,
			);
			if (
				incoming &&
				new Date(incoming.receivedAt) <
					(prospect.initialSentAt ?? prospect.createdAt)
			)
				continue;
			if (message.labelIds?.includes("SENT")) {
				await this.stop(
					prospect,
					"REPLIED",
					"A manual outbound email exists. Automation is paused.",
					null,
					{ id, incoming: null },
				);
				return false;
			}
			await this.stop(
				prospect,
				status,
				"A new mailbox message requires attention",
				body.slice(0, 8000),
				{ id, incoming },
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
		observation?: { id: string; incoming: IncomingReferral | null },
	) {
		await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${prospect.campaignId} FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${prospect.id} FOR UPDATE`;
			const current = await tx.outreachProspect.findUniqueOrThrow({
				where: { id: prospect.id },
			});
			if (observation) {
				if (
					await tx.outreachInbound.findUnique({
						where: {
							prospectId_messageId: {
								prospectId: prospect.id,
								messageId: observation.id,
							},
						},
					})
				)
					return;
				await tx.outreachInbound.create({
					data: {
						prospectId: prospect.id,
						messageId: observation.id,
						message: observation.incoming ?? {
							captureError:
								"Gmail identity metadata is unavailable or ambiguous",
						},
						classification: status,
					},
				});
			}
			if (
				["SUPPRESSED", "BOUNCED", "BOOKED"].includes(current.status) &&
				status === "REPLIED"
			)
				return;
			const receivedAt = observation?.incoming
				? new Date(observation.incoming.receivedAt)
				: null;
			if (
				status === "REPLIED" &&
				receivedAt &&
				current.replyReceivedAt &&
				receivedAt < current.replyReceivedAt
			)
				return;
			await tx.outreachProspect.update({
				where: { id: prospect.id },
				data: {
					status,
					stoppedAt: new Date(),
					stopReason: reason,
					replyText: reply,
					replyReceivedAt: receivedAt ?? undefined,
					replyDraft: null,
					replyDraftAttempts: 0,
					replyDraftDueAt: new Date(),
					replyDraftLeaseUntil: null,
					lastCheckedAt: new Date(),
				},
			});
			if (
				status === "REPLIED" &&
				observation?.incoming &&
				!current.manual &&
				current.initialSentAt
			) {
				await tx.outreachReferral.create({
					data: {
						prospectId: current.id,
						messageId: observation.id,
						message: observation.incoming,
					},
				});
			}
			if (status === "REPLIED" && observation) {
				await tx.outreachProspect.updateMany({
					where: {
						referredFromId: current.id,
						status: { in: ["HELD", "READY", "ACTIVE"] },
					},
					data: {
						status: "REPLIED",
						stoppedAt: new Date(),
						stopReason:
							"A new reply in the original conversation requires attention",
						replyDraft: null,
					},
				});
			}
			if (["SUPPRESSED", "BOUNCED", "BOOKED"].includes(status)) {
				await tx.outreachProspect.updateMany({
					where: {
						campaignId: current.campaignId,
						domain: current.domain,
						id: { not: current.id },
					},
					data: {
						status,
						stoppedAt: new Date(),
						stopReason: `Related company sequence stopped: ${reason}`,
						replyDraft: null,
					},
				});
			}
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
		let prior = await this.db.outreachDelivery.findUnique({
			where: { prospectId_stage: { prospectId: prospect.id, stage: 0 } },
		});
		if (prospect.nextStage > 0 && prior) {
			await this.log(campaign, prior.id, token);
			prior = await this.db.outreachDelivery.findUniqueOrThrow({
				where: { id: prior.id },
			});
		}
		if (
			prospect.nextStage > 0 &&
			(!prior?.gmailThreadId ||
				!prior.observedRfcMessageId ||
				!prior.loggedAt ||
				!prospect.initialSentAt)
		)
			throw new Error("Initial delivery is not reconciled.");
		const templates = templatesSchema.parse(campaign.templates);
		const draft = currentDraft(prospect, templates);
		if (
			!draft ||
			(prospect.pilotSlot !== null &&
				prospect.emailDraftReviewedHash !== draftReviewHash(draft))
		)
			throw new Error(
				"Current AI drafts and pilot preview review are required. Sending is held.",
			);
		const now = new Date();
		const dayStart = new Date(`${perthDay(now)}T00:00:00+08:00`);
		const delivery = await this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${campaign.id} FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "outreachProspect" WHERE id = ${prospect.id} FOR UPDATE`;
			const current = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: campaign.id },
			});
			const target = await tx.outreachProspect.findUniqueOrThrow({
				where: { id: prospect.id },
			});
			const currentTemplates = templatesSchema.parse(current.templates);
			const parent = target.referredFromId
				? await tx.outreachProspect.findUnique({
						where: { id: target.referredFromId },
					})
				: null;
			const artifact = currentDraft(target, currentTemplates);
			const content = artifact?.stages[target.nextStage];
			const suppressed = target.email
				? await tx.outreachSuppression.findUnique({
						where: { email: target.email },
					})
				: null;
			const crmSuppressed = target.email
				? await tx.suppressedContact.findUnique({
						where: { email: target.email },
					})
				: null;
			const domainSuppressed = await tx.suppressedDomain.findFirst({
				where: {
					domain: {
						in: [target.domain, target.email?.split("@")[1] ?? target.domain],
					},
				},
			});
			if (
				current.sendLease !== lease ||
				(target.referredFromId !== null &&
					(!parent ||
						parent.manual ||
						parent.status !== "REPLIED" ||
						parent.domain !== target.domain ||
						target.referralDepth > OUTREACH_AUTOMATION.maxReferralDepth)) ||
				(current.status === "PILOT" &&
					target.pilotSlot === null &&
					!parent?.pilotSlot) ||
				!current.sendLeaseUntil ||
				current.sendLeaseUntil <= now ||
				!sendWindow(now) ||
				!["PILOT", "ACTIVE"].includes(current.status) ||
				current.approvedHash !== campaign.approvedHash ||
				current.approvedHash !== campaignHash(currentTemplates) ||
				!readinessSchema.safeParse(current.readiness).success ||
				!artifact ||
				!content ||
				artifact.inputHash !== draft.inputHash ||
				suppressed ||
				crmSuppressed ||
				domainSuppressed ||
				(target.pilotSlot !== null &&
					target.emailDraftReviewedHash !== draftReviewHash(artifact)) ||
				target.email !== prospect.email ||
				target.manual ||
				!["READY", "ACTIVE"].includes(target.status) ||
				target.nextStage !== prospect.nextStage
			)
				return null;
			await verifiedOutreachContact(tx, target, current.ownerId);
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
					createdAt: now,
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
				subject: delivery.subject,
				body: delivery.body,
				to: prospect.email,
				from: campaign.senderEmail,
				rfcId: delivery.rfcMessageId,
				rootId: prior?.observedRfcMessageId ?? undefined,
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
			await tx.outreachDelivery.updateMany({
				where: {
					id: delivery.id,
					OR: [
						{ gmailMessageId: null, gmailThreadId: null },
						{ gmailMessageId, gmailThreadId },
					],
				},
				data: {
					status: "SENT",
					gmailMessageId,
					gmailThreadId,
					sentAt,
					lastError: null,
				},
			});
			const bound = await tx.outreachDelivery.findUniqueOrThrow({
				where: { id: delivery.id },
			});
			if (
				bound.gmailMessageId !== gmailMessageId ||
				bound.gmailThreadId !== gmailThreadId
			)
				throw new Error(
					"Delivery Gmail identity conflicts with its durable record.",
				);
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
					{ status: "SENT", observedRfcMessageId: null },
				],
			},
			take: 5,
		});
		for (const row of rows) {
			if (!row.gmailMessageId) {
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
				const parsed = this.parser.parse(message);
				const prospect = await this.db.outreachProspect.findUniqueOrThrow({
					where: { id: row.prospectId },
				});
				if (!parsed || !prospect.email)
					throw new Error("Sent email cannot be reconciled.");
				verifiedSentIdentity(
					message,
					parsed,
					{
						...row,
						gmailMessageId: found.id,
						gmailThreadId: found.threadId,
						sender: campaign.senderEmail,
						recipient: prospect.email,
					},
					true,
				);
				await this.finish(row, found.id, found.threadId, parsed.sentAt);
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
		if (!delivery.gmailMessageId || !delivery.gmailThreadId)
			throw new Error("Delivery has no complete Gmail identity.");
		const message = await this.gmail.message(token, delivery.gmailMessageId);
		const parsed = this.parser.parse(message);
		if (!parsed)
			throw new Error("Sent email could not be parsed for CRM logging.");
		const prospect = await this.db.outreachProspect.findUniqueOrThrow({
			where: { id: delivery.prospectId },
		});
		if (!prospect.email)
			throw new Error("Sent email has no durable recipient.");
		const observedRfcMessageId = verifiedSentIdentity(message, parsed, {
			...delivery,
			sender: campaign.senderEmail,
			recipient: prospect.email,
		});
		await this.db.outreachDelivery.updateMany({
			where: {
				id: delivery.id,
				observedRfcMessageId: null,
				gmailMessageId: delivery.gmailMessageId,
				gmailThreadId: delivery.gmailThreadId,
			},
			data: { observedRfcMessageId },
		});
		const bound = await this.db.outreachDelivery.findUniqueOrThrow({
			where: { id: delivery.id },
		});
		if (
			bound.observedRfcMessageId !== observedRfcMessageId ||
			bound.gmailMessageId !== delivery.gmailMessageId ||
			bound.gmailThreadId !== delivery.gmailThreadId
		)
			throw new Error(
				"Delivery identity binding conflicts with its durable record.",
			);
		if (delivery.status !== "SENT")
			await this.finish(
				bound,
				delivery.gmailMessageId,
				delivery.gmailThreadId,
				parsed.sentAt,
			);
		if (delivery.loggedAt) return;
		const contactId = await verifiedOutreachContact(
			this.db,
			prospect,
			campaign.ownerId,
		);
		const mailbox = await this.db.mailboxSync.findUniqueOrThrow({
			where: { userId_source: { userId: campaign.ownerId, source: "gmail" } },
		});
		await storeOutreachMessage(
			this.db,
			this.writer,
			mailbox,
			campaign.senderEmail,
			parsed,
			contactId,
		);
		await this.db.outreachDelivery.update({
			where: { id: delivery.id },
			data: { loggedAt: new Date() },
		});
	}

	private async advancePilot(campaign: OutreachCampaignModel) {
		if (campaign.status !== "PILOT") return campaign;
		return this.db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "outreachCampaign" WHERE id = ${campaign.id} FOR UPDATE`;
			const current = await tx.outreachCampaign.findUniqueOrThrow({
				where: { id: campaign.id },
			});
			if (
				current.status !== "PILOT" ||
				current.approvedHash !==
					campaignHash(templatesSchema.parse(current.templates)) ||
				!readinessSchema.safeParse(current.readiness).success
			)
				return current;
			const progress = await pilotProgress(tx, current.id, new Date());
			if (!progress.ready && !progress.blocked) return current;
			return tx.outreachCampaign.update({
				where: { id: current.id },
				data: {
					status: progress.blocked ? "PAUSED" : "ACTIVE",
					pilotPassedAt: progress.ready ? new Date() : undefined,
					lastError: progress.blocked ? progress.reason : null,
				},
			});
		});
	}

	private async report(campaign: OutreachCampaignModel) {
		const currentWeek = weekStart(new Date());
		if (campaign.createdAt >= currentWeek) return;
		const existing = new Set(
			(
				await this.db.outreachReport.findMany({
					where: { campaignId: campaign.id },
					select: { week: true },
				})
			).map((row) => row.week.toISOString()),
		);
		const start = weekStart(campaign.createdAt);
		while (existing.has(start.toISOString()))
			start.setTime(start.getTime() + OUTREACH.dayMs * 7);
		if (start >= currentWeek) return;
		const end = new Date(start.getTime() + OUTREACH.dayMs * 7);
		const id = `${campaign.id}:${perthDay(start)}`;
		if (await this.db.outreachReport.findUnique({ where: { id } })) return;
		const [researched, sent, replies, meetings, held, budgets, eligible] =
			await Promise.all([
				this.db.outreachProspect.count({
					where: {
						campaignId: campaign.id,
						referredFromId: null,
						createdAt: { gte: start, lt: end },
					},
				}),
				this.db.outreachDelivery.count({
					where: {
						prospect: { campaignId: campaign.id },
						status: "SENT",
						sentAt: { gte: start, lt: end },
					},
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
