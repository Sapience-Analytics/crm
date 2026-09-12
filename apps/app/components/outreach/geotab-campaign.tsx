"use client";

import { authClient } from "@crm/auth/client";
import { Button } from "@crm/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@crm/ui/components/card";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@crm/ui/components/select";
import { Textarea } from "@crm/ui/components/textarea";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseAsString, useQueryStates } from "nuqs";
import { useState } from "react";
import { toast } from "sonner";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";
import { ControlledTests } from "./controlled-tests";

type Templates = {
	subject: string;
	initial: string;
	followup1: string;
	followup2: string;
	signature: string;
};

export function GeotabCampaign() {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const [page, setPage] = useState(0);
	const [oauth] = useQueryStates({
		error: parseAsString,
		error_description: parseAsString,
	});
	const status = useQuery({
		...trpc.outreach.status.queryOptions(),
		refetchInterval: 30_000,
	});
	const prospects = useQuery({
		...trpc.outreach.prospects.queryOptions({ page }),
		refetchInterval: 30_000,
	});
	const options = {
		onSuccess: () => cache.outreach(),
		onError: (error: { message: string }) => toast.error(error.message),
	};
	const initialize = useMutation(
		trpc.outreach.initialize.mutationOptions(options),
	);
	const action = useMutation(trpc.outreach.action.mutationOptions(options));
	const stop = useMutation(trpc.outreach.stop.mutationOptions(options));
	const campaign = status.data;
	if (status.error) return <p role="alert">{status.error.message}</p>;
	if (!campaign) return <p>Loading campaign…</p>;
	if (!campaign.exists)
		return (
			<Button
				disabled={initialize.isPending}
				onClick={() => initialize.mutate()}
			>
				Create paused Geotab campaign
			</Button>
		);
	return (
		<div className="flex flex-col gap-6">
			<Card>
				<CardHeader>
					<CardTitle>Campaign: {campaign.status}</CardTitle>
					<CardDescription>
						Cloud research → CompAI → Gmail. Replies come back to you.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<p>
						50 new WA prospects each week. Pilot: 10 automatic and 2 manual.
						Manual prospects never enter automation.
					</p>
					<p>
						Weekdays, 10 am–3 pm Perth time. Up to 10 initial emails and 30
						total emails daily.
					</p>
					<p>
						Follow-ups: 4 and 10 business days after the initial email. Replies,
						opt-outs, bounces and bookings stop the sequence.
					</p>
					<p>
						Last sender check: {campaign.lastTickAt ?? "Not run"}. Last
						research: {campaign.lastResearchAt ?? "Not run"}.
					</p>
					{campaign.lastError && <p role="alert">{campaign.lastError}</p>}
					{campaign.researchError && (
						<p role="alert">{campaign.researchError}</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							disabled={action.isPending}
							onClick={() =>
								action.mutate({
									action: campaign.researchEnabled
										? "research-off"
										: "research-on",
								})
							}
						>
							{campaign.researchEnabled
								? "Pause research"
								: "Start cloud research"}
						</Button>
						<Button
							variant="outline"
							disabled={action.isPending}
							onClick={() => action.mutate({ action: "pause" })}
						>
							Pause sending
						</Button>
						<Button
							disabled={
								action.isPending ||
								!campaign.approved ||
								!campaign.ready ||
								!campaign.sendConnected
							}
							onClick={() => action.mutate({ action: "start-pilot" })}
						>
							Start approved pilot
						</Button>
						<Button
							variant="outline"
							disabled={
								action.isPending ||
								!campaign.approved ||
								!campaign.ready ||
								!campaign.sendConnected
							}
							onClick={() => action.mutate({ action: "start-active" })}
						>
							Accept pilot and start weekly campaign
						</Button>
					</div>
					{!campaign.sendConnected &&
						(oauth.error || oauth.error_description) && (
							<p role="alert">
								Google connection did not finish. Reconnect Gmail sending and
								complete the Google permission screen.
							</p>
						)}
					{!campaign.sendConnected && (
						<Button
							variant="outline"
							onClick={async () => {
								const callback = new URL(window.location.href);
								callback.searchParams.delete("error");
								callback.searchParams.delete("error_description");
								const result = await authClient.linkSocial({
									provider: "google",
									scopes: [
										"https://www.googleapis.com/auth/gmail.readonly",
										"https://www.googleapis.com/auth/calendar.readonly",
										"https://www.googleapis.com/auth/gmail.send",
									],
									callbackURL: callback.toString(),
									errorCallbackURL: callback.toString(),
								});
								if (result.error)
									toast.error(
										result.error.message ?? "Google connection failed",
									);
							}}
						>
							Connect Gmail sending
						</Button>
					)}
					<p>
						{campaign.counts
							.map((group) => `${group.status}: ${group.count}`)
							.join(" · ") || "No prospects yet"}
					</p>
				</CardContent>
			</Card>
			<TemplateEditor key={campaign.hash} initial={campaign.templates} />
			<Button
				disabled={action.isPending || campaign.approved}
				onClick={() =>
					action.mutate({ action: "approve", hash: campaign.hash })
				}
			>
				{campaign.approved
					? "Rules and templates approved"
					: "Approve these rules and templates"}
			</Button>
			<ControlledTests sendConnected={campaign.sendConnected} />
			<LaunchChecks ready={campaign.ready} />
			<Card>
				<CardHeader>
					<CardTitle>Budget and weekly reports</CardTitle>
				</CardHeader>
				<CardContent>
					<p>
						US$10 monthly CRM AI limit and US$10 research allowance. Hosting and
						Context enrichment are separate.
					</p>
					{campaign.budgets.map((budget) => (
						<p key={budget.id}>
							{budget.id}: ${(budget.reservedMicroUsd / 1_000_000).toFixed(2)}{" "}
							charged or reserved; $
							{(budget.actualMicroUsd / 1_000_000).toFixed(2)} confirmed
							provider cost; {budget.calls} calls.
						</p>
					))}
					{campaign.reports.map((report) => (
						<div key={report.week}>
							<p>Week of {report.week.slice(0, 10)}</p>
							<p>
								{report.summary.researched} researched ·{" "}
								{report.summary.eligible} eligible · {report.summary.sent}{" "}
								emails sent
							</p>
							<p>
								{report.summary.replies} replies · {report.summary.meetings}{" "}
								meetings · {report.summary.held} prospects on hold
							</p>
						</div>
					))}
				</CardContent>
			</Card>
			{prospects.error && <p role="alert">{prospects.error.message}</p>}
			{prospects.data?.rows.map((prospect) => (
				<Card key={prospect.id}>
					<CardHeader>
						<CardTitle>
							{prospect.company} — {prospect.status}
						</CardTitle>
						<CardDescription>
							{prospect.email ?? "No published email"} · Fleet:{" "}
							{prospect.fleetBand}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<p>{prospect.fit}</p>
						<p>{prospect.sourceQuote}</p>
						<a href={prospect.sourceUrl} target="_blank" rel="noreferrer">
							Review company source
						</a>
						<p>{prospect.stopReason}</p>
						{prospect.manual && (
							<p>
								Manual test prospect. Send and follow up yourself. Automation is
								permanently excluded.
							</p>
						)}
						<details>
							<summary>Initial email preview</summary>
							<p>{prospect.preview.subject}</p>
							<pre className="whitespace-pre-wrap">{prospect.preview.body}</pre>
						</details>
						{prospect.status === "HELD" &&
							prospect.verified &&
							prospect.email && <QualifyProspect id={prospect.id} />}
						{prospect.replyDraft && (
							<>
								<Label>Reply draft — review and send yourself</Label>
								<Textarea readOnly value={prospect.replyDraft} rows={8} />
								<Button
									variant="outline"
									onClick={() =>
										navigator.clipboard.writeText(prospect.replyDraft ?? "")
									}
								>
									Copy reply draft
								</Button>
							</>
						)}
						<Button
							variant="outline"
							disabled={stop.isPending || prospect.status === "SUPPRESSED"}
							onClick={() => stop.mutate({ id: prospect.id })}
						>
							Stop and suppress
						</Button>
					</CardContent>
				</Card>
			))}
			<div className="flex gap-2">
				<Button
					variant="outline"
					disabled={page === 0}
					onClick={() => setPage(page - 1)}
				>
					Previous
				</Button>
				<Button
					variant="outline"
					disabled={(page + 1) * 50 >= (prospects.data?.total ?? 0)}
					onClick={() => setPage(page + 1)}
				>
					Next
				</Button>
			</div>
		</div>
	);
}

function TemplateEditor({ initial }: { initial: Templates }) {
	const [templates, setTemplates] = useState(initial);
	const trpc = useTRPC();
	const cache = useCrmCache();
	const update = useMutation(
		trpc.outreach.update.mutationOptions({
			onSuccess: () => cache.outreach(),
			onError: (error) => toast.error(error.message),
		}),
	);
	const fields = [
		"subject",
		"initial",
		"followup1",
		"followup2",
		"signature",
	] as const;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Email templates</CardTitle>
				<CardDescription>
					Personalisation uses the company name and an exact source quote.
					Changes pause sending and clear approval.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{fields.map((field) => (
					<div key={field}>
						<Label htmlFor={`template-${field}`}>{field}</Label>
						<Textarea
							id={`template-${field}`}
							rows={field === "subject" ? 2 : 6}
							value={templates[field]}
							onChange={(event) =>
								setTemplates({ ...templates, [field]: event.target.value })
							}
						/>
					</div>
				))}
				<Button
					disabled={update.isPending}
					onClick={() => update.mutate({ templates })}
				>
					Save templates and pause sending
				</Button>
			</CardContent>
		</Card>
	);
}

function QualifyProspect({ id }: { id: string }) {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const [kind, setKind] = useState<
		"express" | "existing-relationship" | "published-business-role"
	>("express");
	const [source, setSource] = useState("");
	const [evidence, setEvidence] = useState("");
	const qualify = useMutation(
		trpc.outreach.qualify.mutationOptions({
			onSuccess: () => cache.outreach(),
			onError: (error) => toast.error(error.message),
		}),
	);
	return (
		<details>
			<summary>Record contact eligibility</summary>
			<p>
				A public email alone is insufficient. Confirm the role is relevant and
				no restriction prevents this message.
			</p>
			<Select
				value={kind}
				onValueChange={(value) => {
					if (
						value === "express" ||
						value === "existing-relationship" ||
						value === "published-business-role"
					)
						setKind(value);
				}}
			>
				<SelectTrigger aria-label="Contact basis">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="express">Express consent</SelectItem>
					<SelectItem value="existing-relationship">
						Existing relationship
					</SelectItem>
					<SelectItem value="published-business-role">
						Published business role with documented inferred consent
					</SelectItem>
				</SelectContent>
			</Select>
			<Label htmlFor={`${id}-source`}>Source or CRM evidence reference</Label>
			<Input
				id={`${id}-source`}
				value={source}
				onChange={(event) => setSource(event.target.value)}
			/>
			<Label htmlFor={`${id}-basis`}>
				Evidence, role relevance and absence of restrictions
			</Label>
			<Textarea
				id={`${id}-basis`}
				value={evidence}
				onChange={(event) => setEvidence(event.target.value)}
			/>
			<Button
				disabled={
					qualify.isPending ||
					evidence.trim().length < 30 ||
					source.trim().length < 5
				}
				onClick={() =>
					qualify.mutate({
						id,
						consent: {
							kind,
							evidence,
							source,
							roleRelevant: true,
							noRestriction: true,
						},
					})
				}
			>
				Confirm eligibility and allocate prospect
			</Button>
		</details>
	);
}

function LaunchChecks({ ready }: { ready: boolean }) {
	const [evidence, setEvidence] = useState("");
	const trpc = useTRPC();
	const cache = useCrmCache();
	const save = useMutation(
		trpc.outreach.readiness.mutationOptions({
			onSuccess: () => cache.outreach(),
			onError: (error) => toast.error(error.message),
		}),
	);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Launch checks: {ready ? "recorded" : "required"}</CardTitle>
			</CardHeader>
			<CardContent>
				<p>
					Verify SPF, DKIM and DMARC. Test controlled delivery, reply stops,
					opt-out stops and CRM message logging.
				</p>
				<Label htmlFor="launch-evidence">
					Record the test results and evidence references
				</Label>
				<Textarea
					id="launch-evidence"
					value={evidence}
					onChange={(event) => setEvidence(event.target.value)}
				/>
				<Button
					disabled={save.isPending || evidence.trim().length < 30}
					onClick={() =>
						save.mutate({
							spf: true,
							dkim: true,
							dmarc: true,
							controlledDelivery: true,
							replyStop: true,
							optOutStop: true,
							logging: true,
							evidence,
						})
					}
				>
					Confirm all launch checks passed
				</Button>
			</CardContent>
		</Card>
	);
}
