export type CheckDomain = "accessibility" | "design";
export type CheckTier = "deterministic" | "inference";
export type SelectionOptions = { checks?: string; tier?: CheckTier };
export type PdfOptions = SelectionOptions & { maxSparseWords?: number; minImagePpi?: number; paperSize?: "A4" | "Letter"; pdfua?: "ua1" | "ua2" | "off"; veraPdfPath?: string };

export function parseChecks(value: string): CheckDomain[] {
	const parts = value.split(",");
	if (!parts.length || new Set(parts).size !== parts.length || parts.some((part) => part !== "accessibility" && part !== "design")) throw new Error("--checks must be accessibility, design, or accessibility,design");
	return (["accessibility", "design"] as const).filter((domain) => parts.includes(domain));
}

export function parseTier(value: string): CheckTier {
	if (value !== "deterministic" && value !== "inference") throw new Error("--tier must be deterministic or inference");
	return value;
}

export function selectChecks(options: SelectionOptions, defaults = "accessibility") {
	return { checks: parseChecks(options.checks ?? defaults), tier: parseTier(options.tier ?? "deterministic") };
}

export function validateHtmlSelection(command: string, options: SelectionOptions) {
	const selection = selectChecks({ ...options, tier: options.tier ?? (command === "prepare-review" ? "inference" : "deterministic") });
	if (selection.checks.includes("design")) throw new Error("Design checks are not supported for HTML, folders or SCORM ZIPs; no design assessment was performed.");
	if (command === "prepare-review" && selection.tier !== "inference") throw new Error("prepare-review requires --tier inference; use check for deterministic checks.");
	return selection;
}

/** Preserve legacy combined PDF checks when the tier was omitted. */
export function normalizePdfPolicy(options: PdfOptions) {
	if (options.maxSparseWords !== undefined && (!Number.isSafeInteger(options.maxSparseWords) || options.maxSparseWords < 1)) throw new Error("maxSparseWords must be a positive safe integer");
	if (options.minImagePpi !== undefined && (!Number.isFinite(options.minImagePpi) || options.minImagePpi <= 0)) throw new Error("minImagePpi must be a positive finite number");
	if (options.paperSize !== undefined && options.paperSize !== "A4" && options.paperSize !== "Letter") throw new Error("paperSize must be A4 or Letter");
	if (options.pdfua !== undefined && !["ua1", "ua2", "off"].includes(options.pdfua)) throw new Error("pdfua must be ua1, ua2 or off");
	if (options.veraPdfPath !== undefined && !options.veraPdfPath.trim()) throw new Error("veraPdfPath must not be empty");
	const selection = selectChecks(options, options.tier === undefined ? "accessibility,design" : "accessibility");
	return { ...options, checks: selection.checks.join(","), tier: selection.tier, pdfua: options.pdfua ?? "ua1" };
}
