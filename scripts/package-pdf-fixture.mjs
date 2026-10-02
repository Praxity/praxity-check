// Original synthetic PDF. The Type 3 A glyph avoids host fonts and third-party assets.
export function syntheticPdfUa({ displayTitle = true } = {}) {
	const stream = (content, attributes = "") => `<< /Length ${Buffer.byteLength(content)} ${attributes} >>\nstream\n${content}\nendstream`;
	const metadata = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" pdfuaid:part="1"/><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Synthetic letter A</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>';
	const unicode = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /SyntheticA-Unicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n1 beginbfchar\n<41> <0041>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
	const objects = [
		`<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R /StructTreeRoot 6 0 R /MarkInfo << /Marked true >> /Lang (en-US) /ViewerPreferences << /DisplayDocTitle ${displayTitle} >> >>`,
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 10 0 R >> >> /Contents 5 0 R /StructParents 0 /Tabs /S >>",
		stream(metadata, "/Type /Metadata /Subtype /XML"),
		stream("/P <</MCID 0>> BDC\nBT /F1 36 Tf 72 700 Td (A) Tj ET\nEMC"),
		"<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 8 0 R /ParentTreeNextKey 1 >>",
		"<< /Type /StructElem /S /Document /P 6 0 R /K [9 0 R] >>",
		"<< /Nums [0 [9 0 R]] >>",
		"<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 >>",
		"<< /Type /Font /Subtype /Type3 /Name /SyntheticA /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /A 11 0 R >> /Encoding << /Type /Encoding /Differences [65 /A] >> /FirstChar 65 /LastChar 65 /Widths [600] /Resources << >> /ToUnicode 12 0 R >>",
		stream("600 0 0 0 600 700 d1\n60 w\n30 0 m 300 670 l 570 0 l S\n150 300 m 450 300 l S"),
		stream(unicode),
		"<< /Title (Synthetic letter A) /Producer (Praxity Check synthetic runtime proof) >>",
	];
	let pdf = "%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n";
	const offsets = objects.map((object, index) => {
		const offset = Buffer.byteLength(pdf);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 13 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}
