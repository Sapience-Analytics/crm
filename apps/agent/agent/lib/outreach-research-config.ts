export const RESEARCH_PROVIDER = {
	url: "https://api.perplexity.ai/v1/agent",
	model: "openai/gpt-5.6-luna",
	serviceTier: "default",
	maxSteps: 1,
	maxRequestBytes: 16_000,
	maxResponseBytes: 500_000,
	search: { maxResults: 10, maxTokens: 6000, maxTokensPerPage: 1200 },
	pricing: {
		inputUsdPerMillion: 0.2,
		outputUsdPerMillion: 1.2,
		searchMicroUsd: 2500,
		modelPasses: 2,
	},
} as const;
