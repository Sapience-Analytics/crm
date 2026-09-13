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
import { OUTREACH_INTAKE } from "@crm/validation/outreach-intake";
import { getDomain } from "tldts";
import {
	normalizeContactText,
	verifyContactCandidate,
	visibleContactText,
} from "./outreach-contact-source";
import { decodeCloudflareEmail } from "./outreach-email-source";
import {
	fetchResearch,
	ResearchProviderError,
	researchRequest,
} from "./outreach-research-provider";
import { scheduleTask } from "./tasks";

function normalize(text: string) {
	return text
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<\/?span\b[^>]*>/gi, "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, " ")
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function sourceHostMatches(evidence: ProspectEvidence, finalUrl: URL) {
	const host = finalUrl.hostname.replace(/^www\./, "");
	const domain = evidence.domain.replace(/^www\./, "");
	const companyDomain = getDomain(domain, { allowPrivateDomains: true });
	return (
		finalUrl.protocol === "https:" &&
		companyDomain !== null &&
		companyDomain === domain &&
		getDomain(host, { allowPrivateDomains: true }) === companyDomain
	);
}

function publishedEmail(text: string, email: string) {
	const visible = text.replace(
		/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi,
		" ",
	);
	const addresses =
		`${visible}\n${normalize(visible)}`
			.toLowerCase()
			.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
	const encoded = [
		...visible.matchAll(/\bdata-cfemail\s*=\s*["']([^"']+)["']/gi),
		...visible.matchAll(/\/cdn-cgi\/l\/email-protection#([a-f0-9]+)/gi),
	];
	return (
		addresses.some((address) => address === email.toLowerCase()) ||
		encoded.some(
			(match) => decodeCloudflareEmail(match[1] ?? "") === email.toLowerCase(),
		)
	);
}

export function verifyProspectSource(
	evidence: ProspectEvidence,
	text: string,
	finalUrl: URL,
	contactProof?: { text: string; url: URL },
): boolean {
	if (!sourceHostMatches(evidence, finalUrl)) return false;
	const source = normalize(text);
	if (
		!source.includes(normalize(evidence.sourceQuote)) ||
		!source.includes(normalize(evidence.waQuote))
	)
		return false;
	if (evidence.contactTarget) {
		const target = evidence.contactTarget;
		if (
			!contactProof ||
			target.email !== evidence.email ||
			target.sourceUrl !== evidence.contactSourceUrl ||
			!verifyContactCandidate(
				target,
				evidence.domain,
				evidence.email,
				contactProof.text,
				contactProof.url,
			)
		)
			return false;
	}
	if (evidence.contactSourceUrl || evidence.contactRoleQuote)
		return Boolean(
			evidence.email &&
				evidence.contactSourceUrl &&
				evidence.contactRoleQuote &&
				contactProof &&
				sourceHostMatches(evidence, contactProof.url) &&
				visibleContactText(contactProof.text).includes(
					normalizeContactText(evidence.contactRoleQuote),
				) &&
				publishedEmail(contactProof.text, evidence.email),
		);
	return evidence.email === null || publishedEmail(text, evidence.email);
}

export async function readSource(url: string) {
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

export async function checkProspectSources(evidence: ProspectEvidence) {
	const [source, contact] = await Promise.all([
		readSource(evidence.sourceUrl),
		evidence.contactSourceUrl &&
		evidence.contactSourceUrl !== evidence.sourceUrl
			? readSource(evidence.contactSourceUrl)
			: Promise.resolve(null),
	]);
	if (!source) return false;
	return verifyProspectSource(
		evidence,
		source.text,
		source.url,
		evidence.contactSourceUrl === evidence.sourceUrl
			? source
			: (contact ?? undefined),
	);
}

export class ProspectBindingError extends Error {
	constructor() {
		super(OUTREACH_INTAKE.bindingReason);
	}
}

export async function verifiedProspectBinding(
	tx: Prisma.TransactionClient,
	evidence: ProspectEvidence,
	ownerId: string,
) {
	if (!evidence.verified) return { company: null, contact: null };
	await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`outreach-company:${evidence.domain}`}))`;
	await tx.$queryRaw`SELECT id FROM "company" WHERE lower(domain) = ${evidence.domain} FOR UPDATE`;
	const companies = await tx.company.findMany({
		where: { domain: { equals: evidence.domain, mode: "insensitive" } },
	});
	let company = companies[0];
	if (
		companies.length > 1 ||
		(company && (company.archivedAt || company.ownerId !== ownerId))
	)
		throw new ProspectBindingError();
	if (evidence.email) {
		await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`outreach-contact:${evidence.email}`}))`;
		if (
			(await tx.outreachSuppression.findFirst({
				where: { email: { equals: evidence.email, mode: "insensitive" } },
			})) ||
			(await tx.suppressedContact.findFirst({
				where: { email: { equals: evidence.email, mode: "insensitive" } },
			}))
		)
			throw new ProspectBindingError();
	}
	if (
		await tx.suppressedDomain.findFirst({
			where: {
				domain: {
					in: [
						evidence.domain,
						evidence.email?.split("@")[1] ?? evidence.domain,
					],
					mode: "insensitive",
				},
			},
		})
	)
		throw new ProspectBindingError();
	if (!company)
		company = await tx.company.create({
			data: {
				name: evidence.company,
				domain: evidence.domain,
				website: `https://${evidence.domain}`,
				ownerId,
			},
		});
	if (!evidence.email) return { company, contact: null };
	await tx.$queryRaw`SELECT id FROM "contact" WHERE lower(email) = ${evidence.email} FOR UPDATE`;
	const contacts = await tx.contact.findMany({
		where: { email: { equals: evidence.email, mode: "insensitive" } },
	});
	let contact = contacts[0];
	if (
		contacts.length > 1 ||
		(contact &&
			(contact.archivedAt ||
				contact.ownerId !== ownerId ||
				contact.companyId !== company.id))
	)
		throw new ProspectBindingError();
	if (!contact)
		contact = await tx.contact.create({
			data: {
				firstName: evidence.contactTarget?.name ?? evidence.email,
				email: evidence.email,
				companyId: company.id,
				ownerId,
				source: "IMPORT",
				enrichmentStatus: "SKIPPED",
			},
		});
	return { company, contact };
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
		const { company, contact } = await verifiedProspectBinding(
			tx,
			evidence,
			ownerId,
		);
		return tx.outreachProspect.create({
			data: {
				campaignId: OUTREACH.id,
				domain: evidence.domain,
				email: evidence.email,
				companyId: company?.id,
				contactId: contact?.id,
				evidence,
				contactResearch: evidence.verified ? { create: {} } : undefined,
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
			where: {
				campaignId: campaign.id,
				referredFromId: null,
				createdAt: { gte: start },
			},
		});
		if (count >= OUTREACH.weeklyTarget) {
			await db.outreachCampaign.updateMany({
				where: { id: campaign.id, researchLease: lease },
				data: { researchDueAt: new Date(start.getTime() + OUTREACH.dayMs * 7) },
			});
			return;
		}
		const previous = await db.outreachProspect.findMany({
			where: { referredFromId: null },
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
			const evidence = evidenceSchema.parse({
				...candidate,
				fleetBand: "unknown",
				fleetEvidence: "unknown",
				checkedAt: new Date().toISOString(),
				verified: false,
			});
			evidence.verified = await checkProspectSources(evidence);
			try {
				await saveProspect(evidence, campaign.ownerId);
			} catch (error) {
				if (error instanceof ProspectBindingError) {
					await db.outreachProspect.createMany({
						data: [
							{
								campaignId: campaign.id,
								domain: evidence.domain,
								email: evidence.email,
								evidence,
								status: "HELD",
								stopReason: OUTREACH_INTAKE.bindingReason,
								sourceVerificationDueAt: null,
							},
						],
						skipDuplicates: true,
					});
					continue;
				}
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
