"use client";

import { Alert, AlertDescription, AlertTitle } from "@crm/ui/components/alert";
import { Button } from "@crm/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@crm/ui/components/card";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@crm/ui/components/field";
import { Textarea } from "@crm/ui/components/textarea";
import {
	importCandidatesInput,
	OUTREACH_INTAKE,
} from "@crm/validation/outreach-intake";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";

function parseManifest(text: string) {
	try {
		return importCandidatesInput.safeParse(JSON.parse(text));
	} catch {
		return null;
	}
}

export function CandidateIntake() {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const [manifest, setManifest] = useState("");
	const parsed = useMemo(() => parseManifest(manifest), [manifest]);
	const intake = useMutation(
		trpc.outreachIntake.importCandidates.mutationOptions({
			onSuccess: () => cache.outreach(),
			onError: (error) => toast.error(error.message),
		}),
	);
	const invalid = Boolean(manifest.trim()) && !parsed?.success;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Import researched candidates</CardTitle>
				<CardDescription>
					Add up to 12 sourced WA fleet candidates. The cloud verifier checks
					each official website.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<FieldGroup>
					<Field data-invalid={invalid} data-disabled={intake.isPending}>
						<FieldLabel htmlFor="candidate-manifest">
							Candidate JSON manifest
						</FieldLabel>
						<FieldDescription>
							Use a prospects array with company, domain, email, industry,
							fleetBand, fleetEvidence, fit, sourceUrl, sourceQuote and waQuote.
							Set fleetBand and fleetEvidence to unknown. Separate contact pages
							also need contactSourceUrl and contactRoleQuote.
						</FieldDescription>
						<Textarea
							id="candidate-manifest"
							rows={10}
							maxLength={OUTREACH_INTAKE.maxManifestChars}
							value={manifest}
							disabled={intake.isPending}
							aria-invalid={invalid}
							onChange={(event) => setManifest(event.target.value)}
						/>
					</Field>
					{invalid && (
						<Alert variant="destructive">
							<AlertTitle>Check the candidate manifest</AlertTitle>
							<AlertDescription>
								{parsed && !parsed.success
									? parsed.error.issues
											.map(
												(issue) => `${issue.path.join(".")}: ${issue.message}`,
											)
											.join(" · ")
									: "Paste a valid JSON object containing a prospects array."}
							</AlertDescription>
						</Alert>
					)}
					{parsed?.success && (
						<details open>
							<summary>
								Review {parsed.data.prospects.length} candidate source records
							</summary>
							{Array.from(
								new Map(
									parsed.data.prospects.map((candidate) => [
										JSON.stringify(candidate),
										candidate,
									]),
								).entries(),
							).map(([key, candidate]) => (
								<div key={key}>
									<p>
										{candidate.company} · {candidate.domain} ·{" "}
										{candidate.email ?? "No contact email"}
									</p>
									<p>{candidate.fit}</p>
									<a
										href={candidate.sourceUrl}
										target="_blank"
										rel="noreferrer"
									>
										Official fleet source
									</a>
									<p>Fleet quote: {candidate.sourceQuote}</p>
									<p>WA quote: {candidate.waQuote}</p>
									{candidate.contactSourceUrl && (
										<>
											<a
												href={candidate.contactSourceUrl}
												target="_blank"
												rel="noreferrer"
											>
												Official contact source
											</a>
											<p>Contact role quote: {candidate.contactRoleQuote}</p>
										</>
									)}
								</div>
							))}
						</details>
					)}
					<p>
						Imported candidates stay on hold. Source checks do not establish
						consent or allocate pilot slots. Importing sends no emails. Existing
						candidate domains and emails stay unchanged.
					</p>
					{intake.data && (
						<Alert>
							<AlertTitle>
								{intake.data.queued} queued · {intake.data.duplicates}{" "}
								duplicates
							</AlertTitle>
							<AlertDescription>
								{Array.from(
									new Map(
										intake.data.rows.map((row) => [
											`${row.id}-${row.status}`,
											row,
										]),
									).entries(),
								).map(([key, row]) => (
									<p key={key}>
										{row.company}: {row.status}
									</p>
								))}
							</AlertDescription>
						</Alert>
					)}
				</FieldGroup>
			</CardContent>
			<CardFooter>
				<Button
					disabled={intake.isPending || !parsed?.success}
					onClick={() => {
						if (parsed?.success) intake.mutate(parsed.data);
					}}
				>
					{intake.isPending
						? "Importing candidates…"
						: "Import candidates on hold"}
				</Button>
			</CardFooter>
		</Card>
	);
}
