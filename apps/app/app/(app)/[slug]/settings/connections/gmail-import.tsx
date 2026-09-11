"use client";

import { Button } from "@crm/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@crm/ui/components/card";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { SYNC_POLL_MS } from "@/lib/sync-status";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";

export function GmailImport() {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const status = useQuery({
		...trpc.google.importStatus.queryOptions(),
		refetchInterval: SYNC_POLL_MS,
	});
	const options = {
		onSuccess: () => cache.google(),
		onError: (error: { message: string }) => toast.error(error.message),
	};
	const start = useMutation(trpc.google.startImport.mutationOptions(options));
	const advance = useMutation(
		trpc.google.advanceImport.mutationOptions(options),
	);
	const stop = useMutation(trpc.google.stopImport.mutationOptions(options));
	const job = status.data;
	const active = job?.phase === "sent" || job?.phase === "received";
	const busy =
		start.isPending || advance.isPending || stop.isPending || job?.busy;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Import older emails</CardTitle>
				<CardDescription>
					Bring in the past 12 months of business conversations. Existing
					contact filters apply. Gmail stays unchanged.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{job ? (
					<>
						<p>
							{job.phase === "complete"
								? "Import complete"
								: job.phase === "stopped"
									? "Import stopped"
									: job.phase === "sent"
										? "Importing sent emails first"
										: "Importing received emails"}
						</p>
						<p>
							{job.after.slice(0, 10)} to {job.before.slice(0, 10)}
						</p>
						<p>
							{job.reviewed} checked · {job.imported} added · {job.skipped}{" "}
							already present or filtered
						</p>
						{job.lastError ? <p role="alert">{job.lastError}</p> : null}
						{active ? (
							<>
								<p>
									The import continues in the background. Use Continue import to
									process another batch now.
								</p>
								<Button disabled={!!busy} onClick={() => advance.mutate()}>
									{busy ? "Importing…" : "Continue import"}
								</Button>
								<Button
									variant="ghost"
									disabled={!!busy}
									onClick={() => stop.mutate()}
								>
									Stop import
								</Button>
							</>
						) : null}
					</>
				) : (
					<Button
						disabled={status.isPending || !!busy}
						onClick={() => start.mutate()}
					>
						Import past 12 months
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
