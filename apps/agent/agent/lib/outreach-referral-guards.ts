import { OUTREACH } from "@crm/validation/outreach";
import {
	type IncomingReferral,
	OUTREACH_AUTOMATION,
	type ReferralDecision,
} from "@crm/validation/outreach-referrals";

type ParentIdentity = {
	domain: string;
	email: string | null;
	initialSentAt: Date | null;
};

export function freshReferralText(body: string) {
	return (
		body.split(
			/(?:^|\n)\s*(?:On .+wrote:|>|-{2,}\s*(?:Original|Forwarded) Message|Begin forwarded message:|From:|Sent from my\b|--\s*$)/im,
		)[0] ?? ""
	).trim();
}

export function sameCompanyReferralEmail(
	email: string,
	parent: ParentIdentity,
) {
	const domain = email.toLowerCase().split("@")[1];
	return Boolean(
		domain &&
			(domain === parent.domain || domain === parent.email?.split("@")[1]),
	);
}

export function eligibleReferralMessage(
	message: IncomingReferral,
	parent: ParentIdentity,
	now: Date,
) {
	const receivedAt = new Date(message.receivedAt);
	const body = freshReferralText(message.body);
	return Boolean(
		parent.email &&
			parent.initialSentAt &&
			message.authenticated &&
			message.inCampaignThread &&
			message.rfcMessageId &&
			message.fromEmail !== OUTREACH.sender &&
			message.toEmails.length === 1 &&
			message.toEmails[0] === OUTREACH.sender &&
			sameCompanyReferralEmail(message.fromEmail, parent) &&
			receivedAt >= parent.initialSentAt &&
			receivedAt <= now &&
			now.getTime() - receivedAt.getTime() <=
				OUTREACH_AUTOMATION.referralMaxAgeMs &&
			body &&
			!/\b(?:unsubscribe|remove me|stop emailing|do not contact|not interested|out of (?:the )?office|automatic reply|auto[- ]?reply)\b/i.test(
				body,
			),
	);
}

export function eligibleReferralDecision(
	decision: ReferralDecision,
	message: IncomingReferral,
	parent: ParentIdentity,
) {
	if (decision.kind !== "referral") return false;
	const body = freshReferralText(message.body);
	const quote = decision.quote;
	const addresses = [
		...new Set(
			(
				quote.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ??
				[]
			).map((email) => email.toLowerCase()),
		),
	];
	const possibleTargets = [
		...new Set(
			(
				body.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ??
				[]
			)
				.map((email) => email.toLowerCase())
				.filter(
					(email) =>
						email !== parent.email &&
						email !== message.fromEmail &&
						email !== OUTREACH.sender,
				),
		),
	];
	return (
		body.includes(quote) &&
		possibleTargets.length === 1 &&
		possibleTargets[0] === decision.email &&
		addresses.length === 1 &&
		addresses[0] === decision.email &&
		sameCompanyReferralEmail(decision.email, parent) &&
		decision.email !== parent.email &&
		decision.email !== message.fromEmail &&
		decision.email !== OUTREACH.sender &&
		(!decision.name ||
			quote.toLowerCase().includes(decision.name.toLowerCase())) &&
		/\b(?:contact|email|speak (?:with|to)|talk to|reach out|right person|best person|responsible for|handles?|forward|send)\b/i.test(
			quote,
		) &&
		!/\b(?:do not|don't|not allowed|not permitted|avoid contacting)\b/i.test(
			quote,
		)
	);
}
