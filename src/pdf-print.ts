type Evaluation = { rule: string; outcome: "cantTell" | "inapplicable" | "untested"; reason: string };
type Review = { rule: string; message: string; remedy: string; evidence: unknown; location: { page: number } };
export type PdfPrintPolicy = { maxSparseWords?: number; includeSparse?: boolean };

/** Missing inventories mean extraction failed. Empty inventories mean it succeeded. */
export function evaluatePdfPrint(facts: {
	pages?: { page: number }[];
	words?: { page: number; text: string }[];
	images?: { page: number; type?: string; colorSpaceKnown?: boolean }[];
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
	// PDFium reports no color space for stencils. Unknown color spaces cannot exempt
	// a page from sparse review; this preserves coverage without inventing a mask type.
	const imagePages = new Set(facts.images?.filter((image) => (image.type === "image" || image.type === undefined && image.colorSpaceKnown !== false)).map((image) => image.page));
	for (const rule of ["text.extractable", ...(policy.includeSparse === false ? [] : ["page.sparse-content"])]) {
		if (rule === "page.sparse-content" && policy.maxSparseWords === undefined) {
			evaluations.push({ rule, outcome: "untested", reason: "Add --max-sparse-words to check this." });
			continue;
		}
		if (!facts.pages?.length || facts.words === undefined || facts.images === undefined) {
			evaluations.push({ rule, outcome: "untested", reason: "Could not list the pages, text and images this check needs." });
			continue;
		}
		for (const page of facts.pages) {
			const words = wordsByPage.get(page.page) ?? [], hasRasterImages = imagePages.has(page.page);
			if (rule === "text.extractable" && !words.length) needsReview.push({ rule, location: { page: page.page },
				message: hasRasterImages ? "This page has images but no text Check could extract. Look for important text that exists only as an image." : "This page has no text Check could extract. It may hold vector artwork, text converted to outlines, or deliberate white space.",
				remedy: "If the page contains meaningful text, export it as real text or add a checked OCR text layer.",
				evidence: { wordCount: 0, hasRasterImages, vectorArtworkMeasured: false } });
			if (rule === "page.sparse-content" && words.length > 0 && words.length <= policy.maxSparseWords! && !hasRasterImages) needsReview.push({ rule, location: { page: page.page },
				message: `This page has ${policy.maxSparseWords} or fewer words and no images. Check that the page is meant to be there.`,
				remedy: "Keep it if it is a cover, a writing area or an illustration. If it is an accidental extra page, remove it in the source.",
				evidence: { wordCount: words.length, maxSparseWords: policy.maxSparseWords, text: words.join(" "), vectorArtworkMeasured: false } });
		}
		evaluations.push({ rule, outcome: needsReview.some((item) => item.rule === rule) ? "cantTell" : "inapplicable",
			reason: rule === "text.extractable" ? "Screens for pages with no extracted words only. Extraction does not establish visibility, reading order or accessibility." : "Word-count review candidates only. Vector artwork, visible coverage and intended whitespace are not measured; absence of a candidate is not a layout verdict." });
	}
	return { evaluations, findings, needsReview };
}
