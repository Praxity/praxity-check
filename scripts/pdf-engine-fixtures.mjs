import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { syntheticPdfUa } from "./package-pdf-fixture.mjs";

const output = resolve(process.argv[2] ?? "test/fixtures/pdf-engine");
await mkdir(output, { recursive: true });
function pdf(objects) {
	let data = "%PDF-1.7\n";
	const offsets = objects.map((object,i) => { const at=Buffer.byteLength(data); data+=(i+1)+" 0 obj\n"+object+"\nendobj\n"; return at; });
	const xref = Buffer.byteLength(data);
	return Buffer.from(data+"xref\n0 "+(objects.length+1)+"\n0000000000 65535 f \n"+offsets.map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")+"trailer\n<< /Size "+(objects.length+1)+" /Root 1 0 R >>\nstartxref\n"+xref+"\n%%EOF\n");
}
const stream=(text,attrs="")=>"<< /Length "+Buffer.byteLength(text)+" "+attrs+" >>\nstream\n"+text+"\nendstream";
const font="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
function simple(content, resource="", extraObjects=[], pageAttrs="") {
	return pdf(["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 4 0 R >> "+resource+" >> /Contents 5 0 R "+pageAttrs+" >>", font, stream(content), ...extraObjects]);
}
for(const [name,text] of [["unused-font",""],["font-selected-no-text","BT /F1 12 Tf ET"],["used-font-control","BT /F1 12 Tf 20 100 Td (Hello) Tj ET"]])await writeFile(join(output,name+".pdf"),simple(text));
const appearance=stream("BT /F1 12 Tf 20 100 Td (Form text) Tj ET","/Type /XObject /Subtype /Form /BBox [0 0 200 300] /Resources << /Font << /F1 4 0 R >> >>");
await writeFile(join(output,"form-font.pdf"),simple("/Fm Do","/XObject << /Fm 6 0 R >>",[appearance]));
const nested=stream("/Fm Do","/Type /XObject /Subtype /Form /BBox [0 0 200 300] /Resources << /XObject << /Fm 7 0 R >> >>");
await writeFile(join(output,"nested-form-font.pdf"),simple("/Fm Do","/XObject << /Fm 6 0 R >>",[nested,appearance]));
for(const subtype of ["Stamp","Ink","FreeText","Widget"]) {
	const annot="<< /Type /Annot /Subtype /"+subtype+" /Rect [0 0 200 300] /AP << /N 7 0 R >> /F 4 /Contents (Appearance text) >>";
	await writeFile(join(output,"annotation-"+subtype.toLowerCase()+".pdf"),simple("","",[annot,appearance],"/Annots [6 0 R]"));
}
await writeFile(join(output,"word-spacing.pdf"),simple("BT /F1 12 Tf 20 200 Td [(Gap) -500 (word)] TJ 0 -30 Td (Next line) Tj ET BT /F1 12 Tf 0 1 -1 0 160 30 Tm (Turn words) Tj ET"));
await writeFile(join(output,"actualtext.pdf"),simple("/Span <</ActualText (Replacement words)>> BDC 20 40 30 20 re f EMC"));
await writeFile(join(output,"scaled-text.pdf"),simple("BT /F1 1 Tf 12 0 0 12 20 200 Tm (Hello world 0123456789) Tj ET"));
await writeFile(join(output,"embedded-type3.pdf"),syntheticPdfUa());

await writeFile(join(output,"unmapped-font.pdf"),pdf(["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [65 /NoSuchGlyph] >> >>",stream("BT /F1 12 Tf 20 100 Td (A) Tj ET")]));
await writeFile(join(output,"soft-mask.pdf"),simple("q 72 0 0 72 20 100 cm /Im Do Q","/XObject << /Im 6 0 R >>",[stream("ff0000>","/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /SMask 7 0 R"),stream("80>","/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode")]));
await writeFile(join(output,"stencil.pdf"),simple("q 72 0 0 72 20 100 cm /Im Do Q","/XObject << /Im 6 0 R >>",[stream("aa>","/Type /XObject /Subtype /Image /Width 8 /Height 1 /ImageMask true /BitsPerComponent 1 /Filter /ASCIIHexDecode")]));
await writeFile(join(output,"punctuation.pdf"),simple("BT /F1 12 Tf 20 200 Td (Triangle :) Tj 0 -30 Td (f\\(x\\)) Tj ET"));
await writeFile(join(output,"degenerate-image.pdf"),simple("q 0 0 0 0 20 100 cm /Im Do Q","/XObject << /Im 6 0 R >>",[stream("ff0000>","/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode")]));
await writeFile(join(output,"stencil-text.pdf"),simple("BT /F1 12 Tf 20 200 Td (Hello) Tj ET q 72 0 0 72 20 100 cm /Im Do Q","/XObject << /Im 6 0 R >>",[stream("aa>","/Type /XObject /Subtype /Image /Width 8 /Height 1 /ImageMask true /BitsPerComponent 1 /Filter /ASCIIHexDecode")]));
await writeFile(join(output,"fractional-ppi.pdf"),simple("q 0.4792013311 0 0 0.4792013311 20 100 cm /Im Do Q","/XObject << /Im 6 0 R >>",[stream("ff0000>","/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode")]));
await writeFile(join(output,"clipped-cropbox.pdf"),simple("BT /F1 12 Tf 20 100 Td (Hello) Tj ET","",[],"/CropBox [-10 -20 220 330]"));
const longText=deflateSync(Buffer.from(Array.from({length:7},(_,i)=>"BT /F2 12 Tf 20 "+(200-i*20)+" Td ("+"A".repeat(30000)+") Tj ET").join("\n"))).toString("hex")+">";
await writeFile(join(output,"partial-text-warning.pdf"),pdf([
 "<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
 "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
 "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [65 /NoSuchGlyph] >> >>",
 stream("BT /F1 12 Tf 20 100 Td (A) Tj ET"),
 "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F2 7 0 R >> >> /Contents 8 0 R >>",
 font,stream(longText,"/Filter [/ASCIIHexDecode /FlateDecode]")]));



for(const [name,attrs] of [["text","/FT /Tx /V (Field value)"],["choice","/FT /Ch /Ff 131072 /Opt [(One) (Two)] /V (One)"],["button","/FT /Btn /Ff 65536 /MK << /CA (Go) >>"]]){
 await writeFile(join(output,"widget-"+name+".pdf"),pdf([
  "<< /Type /Catalog /Pages 2 0 R /AcroForm 7 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
  font,stream(""),"<< /Type /Annot /Subtype /Widget /Rect [20 80 180 120] /T (Field) /DA (/F1 12 Tf 0 g) /F 4 /Border [0 0 1] "+attrs+" >>",
  "<< /Fields [6 0 R] /NeedAppearances true /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 4 0 R >> >> >>"]));
}

for (const [name, parentAttrs, pageAttrs] of [
 ["inherited-media", "/MediaBox [0 0 200 300]", ""],
 ["inherited-crop", "/MediaBox [0 0 200 300] /CropBox [10 20 190 280] /BleedBox [30 40 170 260] /TrimBox [30 40 170 260] /ArtBox [30 40 170 260]", ""],
 ["overridden-crop", "/MediaBox [0 0 200 300] /CropBox [10 20 190 280]", "/CropBox [20 30 180 270] /TrimBox [25 35 175 265]"]
]) await writeFile(join(output, name+".pdf"), pdf([
 "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [6 0 R] /Count 1 "+parentAttrs+" >>",
 "<< /Type /Page /Parent 6 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R "+pageAttrs+" >>",
 font, stream("BT /F1 12 Tf 20 100 Td (Hello) Tj ET"), "<< /Type /Pages /Parent 2 0 R /Kids [3 0 R] /Count 1 >>"
]));
await writeFile(join(output,"annotation-offset-crop.pdf"), simple("BT /F1 12 Tf 20 100 Td (Hello) Tj ET", "", [
 "<< /Type /Annot /Subtype /Stamp /Rect [0 0 200 300] /AP << /N 7 0 R >> /F 4 >>", appearance
], "/Annots [6 0 R] /CropBox [-10 -20 220 330] /BleedBox [5 10 195 290] /TrimBox [10 15 190 285] /ArtBox [15 20 185 280]"));
for (const subtype of ["FreeText", "Ink", "Square", "Circle", "Line", "Text", "StrikeOut", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly", "Caret", "FileAttachment", "Redact"]) {
 const attrs = subtype === "Ink" ? "/InkList [[20 100 80 100]]" : subtype === "Line" ? "/L [20 100 160 100] /Cap true" : ["Polygon","PolyLine"].includes(subtype) ? "/Vertices [20 80 180 80 100 120]" : ["StrikeOut","Highlight","Underline","Squiggly","Redact"].includes(subtype) ? "/QuadPoints [20 120 180 120 20 80 180 80]" : "";
 await writeFile(join(output,"missing-ap-"+subtype.toLowerCase()+".pdf"),simple("", "", [
  "<< /Type /Annot /Subtype /"+subtype+" /Rect [20 80 180 120] /F 4 /Contents (Appearance text) /DA (/Helvetica 12 Tf 0 g) "+attrs+" >>"
 ], "/Annots [6 0 R]"));
}
await writeFile(join(output,"missing-ap-invalid-ink.pdf"),simple("", "", [
 "<< /Type /Annot /Subtype /Ink /Rect [20 80 180 120] /F 4 /InkList [] >>"
], "/Annots [6 0 R]"));
for(const [name,border] of [["empty","[0 0 0]"],["border","[0 0 1]"]]) await writeFile(join(output,"missing-ap-link-"+name+".pdf"),simple("BT /F1 12 Tf 20 200 Td (Hello) Tj ET", "", [
 "<< /Type /Annot /Subtype /Link /Rect [20 80 180 120] /F 4 /Border "+border+" /A << /S /URI /URI (https://example.org) >> >>"
], "/Annots [6 0 R]"));
for (const angle of [45, 135, 225, 315]) {
 const radians = angle*Math.PI/180, c=Math.cos(radians), s=Math.sin(radians);
 await writeFile(join(output,"oblique-"+angle+".pdf"),simple("BT /F1 12 Tf "+[c,s,-s,c,100,150].join(" ")+" Tm (Hello world 0123456789) Tj ET"));
}
for (const subtype of ["Stamp", "Ink", "FreeText", "Widget"]) for (const [name, flags] of [["noview",32],["hidden",2],["invisible",1],["visible",4]]) {
 await writeFile(join(output,"annotation-"+subtype.toLowerCase()+"-"+name+".pdf"),simple("", "", [
  "<< /Type /Annot /Subtype /"+subtype+" /Rect [0 0 200 300] /AP << /N 7 0 R >> /F "+flags+" >>", appearance
 ], "/Annots [6 0 R]"));
}
for (const rotation of [90,180,270]) for (const flags of [4,12,20,28]) {
 const pageAttrs="/Annots [6 0 R] /CropBox [10 20 190 280] /Rotate "+rotation;
 const attrs="/Rect [100 140 190 180] /F "+flags+" /Contents (Appearance text) /DA (/Helvetica 12 Tf 0 g)";
 await writeFile(join(output,"annotation-rotation-missing-"+rotation+"-"+flags+".pdf"),simple("","",[
  "<< /Type /Annot /Subtype /FreeText "+attrs+" >>"
 ],pageAttrs));
 const saved=stream("BT /F1 12 Tf 2 25 Td (Form text) Tj ET","/Type /XObject /Subtype /Form /BBox [0 0 90 40] /Resources << /Font << /F1 4 0 R >> >>");
 for(const subtype of ["FreeText","Stamp","Ink","Widget"]) await writeFile(join(output,"annotation-rotation-"+subtype.toLowerCase()+"-"+rotation+"-"+flags+".pdf"),simple("","",[
  "<< /Type /Annot /Subtype /"+subtype+" "+attrs+" /AP << /N 7 0 R >> >>",saved
 ],pageAttrs));
}
for (const rotation of [90,180,270]) await writeFile(join(output,"annotation-rotation-shared-"+rotation+".pdf"),simple("BT /F1 12 Tf 20 100 Td (Hello) Tj ET","",[
 "<< /Type /Annot /Subtype /Stamp /Rect [100 140 190 180] /F 20 /AP << /N 9 0 R >> >>",
 "<< /Type /Annot /Subtype /Stamp /Rect [20 40 110 80] /F 4 /AP << /N 9 0 R >> >>",
 "<< /Type /Annot /Subtype /Stamp /Rect [100 140 190 180] /F 2 /AP << /N 9 0 R >> >>",
 stream("BT /F1 12 Tf 2 25 Td (Form text) Tj ET","/Type /XObject /Subtype /Form /BBox [0 0 90 40] /Matrix [2 0 0 0.5 7 9] /Resources << /Font << /F1 4 0 R >> >>"),
 "<< /Type /Annot /Subtype /Link /Rect [20 80 180 120] /F 4 /Border [0 0 0] >>",
 "<< /Type /Annot /Subtype /Widget /Rect [100 80 190 120] /F 28 /AS /On /AP << /N << /On 9 0 R >> >> >>",
 "<< /Type /Annot /Subtype /Popup /Rect [100 140 190 180] /F 20 /AP << /N 9 0 R >> >>"
],"/Annots [6 0 R 7 0 R 8 0 R 10 0 R 11 0 R 12 0 R] /CropBox [10 20 190 280] /Rotate "+rotation));
console.log("Generated original PDF engine fixtures in "+output);
