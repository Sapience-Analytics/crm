import { randomUUID } from "node:crypto";
import { db, Prisma } from "@crm/db";
import {
	reserveOutreachBudget,
	settleOutreachBudget,
} from "@crm/db/outreach-budget";
import { safeFetch } from "@crm/db/safe-fetch";
import {
	evidenceSchema,
	OUTREACH,
	type ProspectEvidence,
	weekStart,
} from "@crm/validation/outreach";
import {
	fetchResearch,
	ResearchProviderError,
	researchRequest,
} from "./outreach-research-provider";
import { scheduleTask } from "./tasks";

function normalize(text: string) {
	return text
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

export function verifyProspectSource(
	evidence: ProspectEvidence,
	text: string,
	finalUrl: URL,
): boolean {
	const host = finalUrl.hostname.replace(/^www\./, "");
	if (host !== evidence.domain && !host.endsWith(`.${evidence.domain}`))
		return false;
	const source = normalize(text);
	return (
		source.includes(normalize(evidence.sourceQuote)) &&
		source.includes(normalize(evidence.waQuote)) &&
		(evidence.email === null || text.toLowerCase().includes(evidence.email))
	);
}

async function readSource(url: string) {
	const result = await safeFetch(url);
	if (!result?.response.ok || !result.response.body) return null;
	const reader = result.response.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.length;
			if (size > OUTREACH.maxSourceBytes) return null;
			parts.push(part.value);
		}
		return { text: Buffer.concat(parts).toString("utf8"), url: result.url };
	} finally {
		await reader.cancel();
	}
}

async function saveProspect(evidence: ProspectEvidence, ownerId: string) {
	const row = await db.$transaction(async (tx) => {
		if (
			await tx.outreachProspect.findFirst({
				where: {
					OR: [
						{ domain: evidence.domain },
						...(evidence.email ? [{ email: evidence.email }] : []),
					],
				},
			})
		)
			return null;
		let company = await tx.company.findFirst({
			where: { domain: evidence.domain, archivedAt: null },
		});
		if (!company && evidence.verified)
			company = await tx.company.create({
				data: {
					name: evidence.company,
					domain: evidence.domain,
					website: `https://${evidence.domain}`,
					ownerId,
				},
			});
		return tx.outreachProspect.create({
			data: {
				campaignId: OUTREACH.id,
				domain: evidence.domain,
				email: evidence.email,
				companyId: company?.id,
				evidence,
				stopReason: evidence.verified
					? "Contact eligibility needs evidence"
					: "Primary source verification failed",
			},
		});
	});
	if (row?.companyId && evidence.verified)
		await scheduleTask({
			companyId: row.companyId,
			kind: "brand",
			reason: "Fill missing company details for a sourced Geotab prospect",
			dueAt: new Date(),
			priority: 900,
			budget: 2,
		});
	return row;
}

export async function runOutreachResearch() {
	if (process.env.VERCEL_ENV !== "production") return;
	const now = new Date();
	const lease = randomUUID();
	const claimed = await db.outreachCampaign.updateMany({
		where: {
			id: OUTREACH.id,
			researchEnabled: true,
			researchDueAt: { lte: now },
			OR: [{ researchLeaseUntil: null }, { researchLeaseUntil: { lt: now } }],
		},
		data: {
			researchLease: lease,
			researchLeaseUntil: new Date(now.getTime() + OUTREACH.leaseMs),
			researchDueAt: new Date(now.getTime() + OUTREACH.minuteMs * 60),
		},
	});
	if (!claimed.count) return;
	try {
		const campaign = await db.outreachCampaign.findUniqueOrThrow({
			where: { id: OUTREACH.id },
		});
		const key = process.env.PERPLEXITY_API_KEY;
		if (!key)
			throw new Error("Connect a Perplexity API key to enable cloud research.");
		const start = weekStart(now);
		const count = await db.outreachProspect.count({
			where: { campaignId: campaign.id, createdAt: { gte: start } },
		});
		if (count >= OUTREACH.weeklyTarget) {
			await db.outreachCampaign.updateMany({
				where: { id: campaign.id, researchLease: lease },
				data: { researchDueAt: new Date(start.getTime() + OUTREACH.dayMs * 7) },
			});
			return;
		}
		const previous = await db.outreachProspect.findMany({
			orderBy: { createdAt: "desc" },
			take: 80,
			select: { domain: true },
		});
		const segments = [
			"transport and distribution",
			"trades and field services",
			"civil contractors",
			"industrial and mining support services",
		];
		const segment =
			segments[
				Math.floor(now.getTime() / (OUTREACH.minuteMs * 60)) % segments.length
			];
		const body = researchRequest(
			`Find up to ${Math.min(5, OUTREACH.weeklyTarget - count)} new Western Australian businesses in ${segment} operating road vehicle fleets. Include all fleet sizes, new tracking and replacement opportunities. Exclude ${previous.map((row) => row.domain).join(", ")}. Use official company websites only. Each prospect needs a verbatim sourceQuote describing road vehicle operations and verbatim waQuote with its WA location from the same sourceUrl. Email must appear on that exact source page; otherwise return null. fleetBand is always unknown in this discovery pass. fleetEvidence is always unknown during discovery; keep any explicit road vehicle count only inside a verified sourceQuote. Plant, employees and trailers are not road vehicle counts. Explain fleet relevance in fit, without claiming buying intent. Return fewer prospects or an empty array when sources do not support these facts.`,
		);
		const budgetId = `research:${now.toISOString().slice(0, 7)}`;
		if (
			!(await reserveOutreachBudget(
				db,
				budgetId,
				OUTREACH.researchReserveMicroUsd,
				OUTREACH.monthlyMicroUsd,
			))
		)
			throw new Error("Monthly US$10 research budget reached.");
		const result = await fetchResearch(body, key, async (actualMicroUsd) => {
			await settleOutreachBudget(
				db,
				budgetId,
				OUTREACH.researchReserveMicroUsd,
				actualMicroUsd,
			);
		});
		for (const candidate of result.prospects.slice(
			0,
			OUTREACH.weeklyTarget - count,
		)) {
			const current = await db.outreachCampaign.findUniqueOrThrow({
				where: { id: campaign.id },
			});
			if (current.researchLease !== lease || !current.researchEnabled) break;
			const source = await readSource(candidate.sourceUrl);
			const evidence = evidenceSchema.parse({
				...candidate,
				fleetBand: "unknown",
				fleetEvidence: "unknown",
				checkedAt: new Date().toISOString(),
				verified: false,
			});
			evidence.verified =
				source !== null &&
				verifyProspectSource(evidence, source.text, source.url);
			try {
				await saveProspect(evidence, campaign.ownerId);
			} catch (error) {
				if (
					!(
						error instanceof Prisma.PrismaClientKnownRequestError &&
						error.code === "P2002"
					)
				)
					throw error;
			}
		}
		await db.outreachCampaign.updateMany({
			where: { id: campaign.id, researchLease: lease },
			data: { lastResearchAt: new Date(), lastResearchError: null },
		});
	} catch (error) {
		await db.outreachCampaign.updateMany({
			where: { id: OUTREACH.id, researchLease: lease },
			data: {
				researchEnabled:
					error instanceof ResearchProviderError && error.pauseResearch
						? false
						: undefined,
				lastResearchError:
					error instanceof Error ? error.message : "Research failed",
			},
		});
	} finally {
		await db.outreachCampaign.updateMany({
			where: { id: OUTREACH.id, researchLease: lease },
			data: { researchLease: null, researchLeaseUntil: null },
		});
	}
}
