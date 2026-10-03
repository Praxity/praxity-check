import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync(join(dirname(require.resolve("@embedpdf/pdfium")), "../package.json"), "utf8")) as { version: string };
export const pdfEngineVersion = { name: "PDFium", package: "@embedpdf/pdfium", version: packageJson.version, build: null,
	buildLimitation: "The distributed package and wasm do not expose the PDFium build number." } as const;
export const pdfCoordinates = {
	boxes: "PDF default user space, bottom-left origin, before page rotation; UserUnit not extracted.",
	text: "Rotated intersection of CropBox and MediaBox, top-left origin, nominal PDF points. Rectangles are [left, top, width, height], enclosing PDFium character boxes. ActualText replacements use the enclosing marked-content region, not individual word glyph boxes. UserUnit scaling is not independently validated.",
	fonts: "Fonts used to paint text in page objects, nested form XObjects and visible annotation appearance streams flattened in a separate extraction copy. Supported missing normal appearances are generated before flattening; appearance generation failures make the affected inventories untested. AcroForm normal appearances are initialized, including unsaved field values and button captions. Unpainted font resources, Hidden and NoView annotations are excluded. Invisible hides unknown subtypes only, matching normal display rendering. Font names may omit subset prefixes; subset status, font type, encoding, ToUnicode presence and PDF object IDs are unavailable.",
	images: "Painted raster objects, including nested forms and visible annotation appearances. Soft masks are internal to their parent image and have no separate rows. PDF object IDs and stencil classification are unavailable; painted image objects are included without inventing either field. colorSpaceKnown records whether PDFium reports a color space; unknown color spaces do not exempt sparse-page review. PPI uses the effective image-to-page matrix in default user space; UserUnit is not validated.",
};
export type PdfPage = { page: number; width: number; height: number; rotation: number; boxes: Record<string, number[]> };
export type PdfFont = { name: string; embedded: boolean; pages: number[] };
export type PdfImage = { page: number; number: number; width: number; height: number; bitsPerPixel: number; colorSpace: number; colorSpaceKnown: boolean; xPpi: number; yPpi: number };
export type PdfWord = { page: number; rect: number[]; text: string };
export type PdfPageSpans = { page: number; width: number; height: number;
	fonts: { id: string; sizePt: number; family: string; color: string }[];
	spans: { left: number; top: number; width: number; height: number; text: string; font: string; bold: boolean; italic: boolean }[] };
export type PdfInventories = { pages: PdfPage[]; fonts: PdfFont[]; images: PdfImage[]; words: PdfWord[] };
export type PdfRender = { height: number } | { dpi: number; rect: { left: number; top: number; width: number; height: number } };
export type PdfEngineLimits = { deadlineMs?: number; maxWasmBytes?: number };
export type PdfEngine = {
	metadata: Record<string, string>;
	diagnostics: string[];
	facts<K extends keyof PdfInventories>(kind: K): Promise<PdfInventories[K]>;
	pageSpans(page: number): Promise<PdfPageSpans>;
	renderPage(page: number, options: PdfRender): Promise<Buffer>;
	close(): Promise<void>;
};

/** One worker per document. Every operation has its own 30 s deadline, matching the former tool deadlines. */
export async function openPdf(bytes: Uint8Array, limits: PdfEngineLimits = {}): Promise<PdfEngine> {
	const deadlineMs = limits.deadlineMs ?? 30_000;
	// 512 MiB allows large source PDFs and 1600 px overviews while bounding wasm growth.
	// Worker resourceLimits only bound V8; the worker checks wasm memory after every native call.
	const maxWasmBytes = limits.maxWasmBytes ?? 512 * 1024 * 1024;
	if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(maxWasmBytes) || maxWasmBytes < 1) throw new Error("Invalid PDF engine limits");
	const copy = Uint8Array.from(bytes);
	const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./pdf-engine-worker.ts" : "./pdf-engine-worker.js", import.meta.url), {
		workerData: { bytes: copy, maxWasmBytes, wasmPath: require.resolve("@embedpdf/pdfium/pdfium.wasm") }, transferList: [copy.buffer],
		resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
	});
	let stopped = false, active = false;
	const diagnostics: string[] = [];
	const close = async () => { stopped = true; await worker.terminate(); };
	const request = <T>(operation: string, data?: unknown): Promise<T> => {
		if (stopped) return Promise.reject(new Error("PDF engine worker is closed"));
		if (active) return Promise.reject(new Error("PDF engine operations must be sequential"));
		active = true;
		return new Promise((resolve, reject) => {
			const cleanup = () => { clearTimeout(timer); worker.off("message", message); worker.off("error", error); worker.off("exit", exited); active = false; };
			const fail = async (e: Error) => { cleanup(); await close(); reject(e); };
			const error = (e: Error) => { void fail(e); };
			const exited = (code: number) => { void fail(new Error(`PDF engine worker exited ${code}`)); };
			const message = (reply: { result?: T; error?: string; fatal?: boolean; diagnostics?: string[] }) => {
				cleanup();
				diagnostics.push(...reply.diagnostics ?? []);
				if (reply.error) {
					const failure = Object.assign(new Error(reply.error), { diagnostics: [...diagnostics] });
					if (reply.fatal) { void close().then(() => reject(failure)); }
					else reject(failure);
				} else resolve(reply.result as T);
			};
			const timer = setTimeout(() => { void fail(new Error(`PDF engine deadline exceeded (${deadlineMs} ms); worker terminated`)); }, deadlineMs);
			worker.once("message", message); worker.once("error", error); worker.once("exit", exited);
			worker.postMessage({ operation, data });
		});
	};
	try {
		const metadata = await request<Record<string, string>>("open");
		return { metadata, diagnostics, facts: kind => request("facts", kind), pageSpans: page => request("spans", page),
			renderPage: async (page, options) => Buffer.from(await request<Uint8Array>("render", { page, options })), close };
	} catch (error) { await close(); throw error; }
}
