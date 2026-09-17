type Evaluation = { rule: string; outcome: "cantTell" | "inapplicable" | "untested"; reason: string };
type Review = { rule: string; message: string; remedy: string; evidence: unknown; location: { page: number } };
export type PdfPrintPolicy = { maxSparseWords?: number; includeSparse?: boolean };

/** Missing inventories mean extraction failed. Empty inventories mean it succeeded. */
export function evaluatePdfPrint(facts: {
	pages?: { page: number }[];
	words?: { page: number; text: string }[];
	images?: { page: number; type: string }[];
}, policy: PdfPrintPolicy = {}) {
	if (policy.maxSparseWords !== undefined && (!Number.isSafeInteger(policy.maxSparseWords) || policy.maxSparseWords < 1)) throw new Error("maxSparseWords must be a positive safe integer");
	const evaluations: Evaluation[] = [], findings: Review[] = [], needsReview: Review[] = [];
	const wordsByPage = new Map<number, string[]>();
	for (const word of facts.words ?? []) {
		if (!word.text.trim()) continue;
		const words = wordsByPage.get(word.page) ?? [];
		words.push(word.text);
		wordsByPage.set(word.page, words);
	}
	const imagePages = new Set(facts.images?.filter((image) => image.type === "image").map((image) => image.page));
	for (const rule of ["text.extractable", ...(policy.includeSparse === false ? [] : ["page.sparse-content"])]) {
		if (rule === "page.sparse-content" && policy.maxSparseWords === undefined) {
			evaluations.push({ rule, outcome: "untested", reason: "No sparse-page word threshold requested." });
			continue;
		}
		if (!facts.pages?.length || facts.words === undefined || facts.images === undefined) {
			evaluations.push({ rule, outcome: "untested", reason: "Page, text and image inventories are required." });
			continue;
		}
		for (const page of facts.pages) {
			const words = wordsByPage.get(page.page) ?? [], hasRasterImages = imagePages.has(page.page);
			if (rule === "text.extractable" && !words.length) needsReview.push({ rule, location: { page: page.page },
				message: hasRasterImages ? "Page has raster images and no extracted words; inspect whether meaningful text is image-only." : "Page has no extracted words; it may contain vector artwork, outlined text or intentional whitespace.",
				remedy: "Inspect the page. If it contains meaningful text, export real text or supply a verified OCR layer.",
				evidence: { wordCount: 0, hasRasterImages, vectorArtworkMeasured: false } });
			if (rule === "page.sparse-content" && words.length > 0 && words.length <= policy.maxSparseWords! && !hasRasterImages) needsReview.push({ rule, location: { page: page.page },
				message: `Page has at most ${policy.maxSparseWords} extracted words and no raster images; inspect whether its pagination is intentional.`,
				remedy: "Keep intentional covers, writing areas and vector illustrations. Adjust source pagination if this is an accidental extra page.",
				evidence: { wordCount: words.length, maxSparseWords: policy.maxSparseWords, text: words.join(" "), vectorArtworkMeasured: false } });
		}
		evaluations.push({ rule, outcome: needsReview.some((item) => item.rule === rule) ? "cantTell" : "inapplicable",
			reason: rule === "text.extractable" ? "Screens for pages with no extracted words only. Extraction does not establish visibility, reading order or accessibility." : "Word-count review candidates only. Vector artwork, visible coverage and intended whitespace are not measured; absence of a candidate is not a layout verdict." });
	}
	return { evaluations, findings, needsReview };
}
