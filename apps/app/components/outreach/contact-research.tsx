"use client";

import { Button } from "@crm/ui/components/button";
import { Checkbox } from "@crm/ui/components/checkbox";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@crm/ui/components/field";
import { Textarea } from "@crm/ui/components/textarea";
import { queueContactResearchInput } from "@crm/validation/outreach-contacts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";

function parseCandidates(id: string, text: string) {
	try {
		return queueContactResearchInput.safeParse({
			id,
			candidates: text.trim() ? JSON.parse(text) : undefined,
		});
	} catch {
		return null;
	}
}

export function ContactResearch({
	id,
	company,
	email,
}: {
	id: string;
	company: string;
	email: string | null;
}) {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const [open, setOpen] = useState(false);
	const [submitted, setSubmitted] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const parsed = parseCandidates(id, submitted);
	const status = useQuery({
		...trpc.outreachContacts.status.queryOptions({ id }),
		enabled: open,
		refetchInterval: (query) =>
			["PENDING", "RESEARCHING"].includes(query.state.data?.status ?? "")
				? 30_000
				: false,
	});
	const research = useMutation(
		trpc.outreachContacts.research.mutationOptions({
			onSuccess: async () => {
				setConfirmed(false);
				await cache.outreach();
				toast.success("Contact research queued. Campaign sending is paused.");
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const select = useMutation(
		trpc.outreachContacts.select.mutationOptions({
			onSuccess: async () => {
				setConfirmed(false);
				await cache.outreach();
				toast.success(
					"Contact selected. Source verification and new draft review are required.",
				);
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const busy = research.isPending || select.isPending;
	const running = ["PENDING", "RESEARCHING"].includes(
		status.data?.status ?? "",
	);
	return (
		<details onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>Research contacts for {company}</summary>
			<FieldGroup>
				<p>
					Find published fleet, transport or operations contacts. Research
					pauses campaign sending and preserves the current contact and drafts
					until selection.
				</p>
				<Field data-invalid={!parsed?.success} data-disabled={busy || running}>
					<FieldLabel htmlFor={`contact-candidates-${id}`}>
						Optional researched contact JSON for {company}
					</FieldLabel>
					<FieldDescription>
						Paste an array of up to three candidates with kind, name, role,
						roleTitle, email, sourceUrl, associationQuote and employmentQuote.
						Submitted candidates require cloud source verification. Leave blank
						to run budgeted contact research.
					</FieldDescription>
					<Textarea
						id={`contact-candidates-${id}`}
						value={submitted}
						rows={5}
						disabled={busy || running}
						aria-invalid={!parsed?.success}
						onChange={(event) => setSubmitted(event.target.value)}
					/>
					{!parsed?.success && (
						<FieldError>
							Enter a valid candidate array without verification fields.
						</FieldError>
					)}
				</Field>
				<Button
					variant="outline"
					disabled={busy || running || !parsed?.success}
					onClick={() => parsed?.success && research.mutate(parsed.data)}
				>
					{running
						? "Contact research queued or running"
						: submitted.trim()
							? "Verify researched contacts"
							: "Research or refresh contacts"}
				</Button>
				{status.isPending && open && (
					<p role="status">Loading contact research…</p>
				)}
				{status.error && <p role="alert">{status.error.message}</p>}
				{status.data && (
					<p role="status">Contact research: {status.data.status}</p>
				)}
				{status.data?.error && <p role="alert">{status.data.error}</p>}
				{Boolean(status.data?.candidates.length) && (
					<Field orientation="horizontal" data-disabled={busy || running}>
						<Checkbox
							id={`contact-confirm-${id}`}
							checked={confirmed}
							disabled={busy || running}
							onCheckedChange={(value) => setConfirmed(value === true)}
						/>
						<FieldLabel htmlFor={`contact-confirm-${id}`}>
							I understand selection pauses sending and clears these draft
							previews and their review. A changed email also requires new
							contact qualification. Manual and pilot assignments remain
							unchanged.
						</FieldLabel>
					</Field>
				)}
				{status.data?.candidates.map((candidate, index) => (
					<section
						key={candidate.id}
						aria-label={`${company} contact option ${index + 1}`}
					>
						<p>
							{index + 1}. {candidate.name ?? "Department inbox"} ·{" "}
							{candidate.roleTitle}
						</p>
						<p>
							{candidate.email ?? "No published work email — research only"}
						</p>
						<a href={candidate.sourceUrl} target="_blank" rel="noreferrer">
							Review official contact source
						</a>
						<p>Contact association: {candidate.associationQuote}</p>
						<p>Current role: {candidate.employmentQuote}</p>
						<p>Verified at {candidate.checkedAt}</p>
						{candidate.email && (
							<>
								<p>
									{candidate.email === email
										? "The email stays unchanged. The recorded contact basis stays unchanged."
										: "The email changes. This prospect returns to hold and its old contact basis is cleared."}
								</p>
								<Button
									variant="outline"
									disabled={
										!confirmed || busy || status.data.status !== "READY"
									}
									aria-label={`Select ${candidate.name ?? candidate.email} for ${company}`}
									onClick={() =>
										select.mutate({ id, candidateId: candidate.id })
									}
								>
									Select contact and recheck
								</Button>
							</>
						)}
					</section>
				))}
			</FieldGroup>
		</details>
	);
}
