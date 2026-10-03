import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { openPdf, pdfCoordinates, type PdfEngine } from "../src/pdf-engine.ts";
import { checkPdf } from "../src/pdf.ts";
import { evaluatePdfPrint } from "../src/pdf-print.ts";

const fixture=(name:string)=>readFile("test/fixtures/pdf-engine/"+name+".pdf");
async function use<T>(name:string,run:(engine:PdfEngine)=>Promise<T>) { const engine=await openPdf(await fixture(name));try{return await run(engine);}finally{await engine.close();} }
function ink(png:Buffer) {
	const width=png.readUInt32BE(16),height=png.readUInt32BE(20),chunks:Buffer[]=[];
	for(let at=8;at<png.length;) {const n=png.readUInt32BE(at);if(png.toString("ascii",at+4,at+8)==="IDAT")chunks.push(png.subarray(at+8,at+8+n));at+=n+12;}
	const raw=inflateSync(Buffer.concat(chunks)); let pixels=0;
	for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=y*(width*3+1)+1+x*3;if(Math.min(raw[at]!,raw[at+1]!,raw[at+2]!)<250)pixels++;}
	return pixels;
}
test("unembedded standard-14 fonts render with ink; overviews and 144 dpi crops have requested dimensions",async()=>{
	await use("used-font-control",async e=>{
		assert.deepEqual(await e.facts("fonts"),[{name:"Helvetica",embedded:false,pages:[1]}]);
		const png=await e.renderPage(1,{height:1600});
		assert.equal(png.readUInt32BE(20),1600);assert.equal(png.readUInt32BE(16),1067);assert.ok(ink(png)>100);
		const crop=await e.renderPage(1,{dpi:144,rect:{left:10,top:180,width:100,height:50}});
		assert.equal(crop.readUInt32BE(16),200);assert.equal(crop.readUInt32BE(20),100);assert.ok(ink(crop)>0);
		await assert.rejects(e.renderPage(1,{dpi:144,rect:{left:0,top:0,width:201,height:1}}),/Invalid PDF crop/);
	});
});
test("font inventory excludes unpainted resources and walks nested forms and visible annotation appearances",async()=>{
	for(const name of ["unused-font","font-selected-no-text"]) {
		await use(name,async e=>assert.deepEqual(await e.facts("fonts"),[]));
		const report=await checkPdf("test/fixtures/pdf-engine/"+name+".pdf",{pdfua:"off"});
		assert.equal(report.findings.filter(f=>f.rule==="font.embedding").length,0);
		assert.equal(report.evaluations.find(e=>e.rule==="font.embedding")?.outcome,"inapplicable");
	}
	for(const name of ["form-font","nested-form-font","annotation-stamp","annotation-ink","annotation-freetext","annotation-widget"]) {
		await use(name,async e=>assert.deepEqual(await e.facts("fonts"),[{name:"Helvetica",embedded:false,pages:[1]}]));
		const report=await checkPdf("test/fixtures/pdf-engine/"+name+".pdf",{pdfua:"off"});
		assert.equal(report.findings.filter(f=>f.rule==="font.embedding").length,1);
	}
	assert.match(pdfCoordinates.fonts,/visible annotation appearance streams/);
	for (const name of ["annotation-stamp","annotation-ink","annotation-freetext","annotation-widget"]) await use(name,async e=>{
		assert.deepEqual((await e.facts("words")).map(w=>w.text),["Form","text"]);
		assert.equal((await e.pageSpans(1)).spans[0]!.text,"Form text");
		assert.ok(ink(await e.renderPage(1,{height:1600}))>0);
	});
});
test("Type 3 font embedding is real source evidence",async()=>{
	await use("embedded-type3",async e=>{
		const fonts=await e.facts("fonts");assert.equal(fonts.length,1);assert.equal(fonts[0]!.embedded,true);
		assert.deepEqual((await e.facts("words")).map(w=>w.text),["A"]);
		assert.ok(ink(await e.renderPage(1,{height:1600}))>0);
	});
});
test("word boxes, whitespace, gaps, line changes, rotations and transformed sizes",async()=>{
	await use("used-font-control",async e=>{
		const words=await e.facts("words");assert.deepEqual(words.map(w=>w.text),["Hello"]);
		const expected=[20.9,191.384,25.992,8.784];
		words[0]!.rect.forEach((n,i)=>assert.ok(Math.abs(n-expected[i]!)<0.1,JSON.stringify(words)));
	});
	await use("word-spacing",async e=>assert.deepEqual((await e.facts("words")).map(w=>w.text),["Gap","word","Next","line","Turn","words"]));
	await use("scaled-text",async e=>{
		const words=await e.facts("words");assert.deepEqual(words.map(w=>w.text),["Hello","world","0123456789"]);
		assert.equal((await e.pageSpans(1)).fonts[0]!.sizePt,12);
		const print=evaluatePdfPrint({pages:await e.facts("pages"),images:await e.facts("images"),words},{maxSparseWords:5});
		assert.equal(print.needsReview.find(r=>r.rule==="page.sparse-content")?.evidence && print.needsReview.length,1);
	});
});
test("ActualText on painted graphics remains extractable, with truthful region boxes",async()=>{
	await use("actualtext",async e=>{
		const words=await e.facts("words");
		assert.deepEqual(words.map(w=>w.text),["Replacement","words"]);
		assert.deepEqual(words.map(w=>w.rect),[[20,240,30,20],[20,240,30,20]]);
		assert.equal(evaluatePdfPrint({pages:await e.facts("pages"),images:[],words},{maxSparseWords:1}).needsReview.length,0);
	});
});
test("rotated page facts and text coordinates use the rotated CropBox",async()=>{
	const engine=await openPdf(await readFile("test/fixtures/pdf-facts.pdf"));
	try {
		const page=(await engine.facts("pages"))[0]!;
		assert.deepEqual([page.width,page.height,page.rotation],[772,592,90]);assert.deepEqual(page.boxes.CropBox,[10,10,602,782]);
		const word=(await engine.facts("words"))[0]!;
		assert.equal(word.text,"PDF");const expected=[90,11.032,8.616,22.632];
		word.rect.forEach((n,i)=>assert.ok(Math.abs(n-expected[i]!)<0.01));
		assert.equal((await engine.renderPage(1,{height:1600})).readUInt32BE(20),1600);
	}finally{await engine.close();}
});
test("encryption with locked or empty passwords is refused",async()=>{
	for(const name of ["encrypted-open","encrypted-locked"])await assert.rejects(openPdf(await fixture(name)),/Encrypted PDFs are not supported/);
});
test("deadline rejects only after terminating the real PDFium worker",async()=>{
	const start=Date.now();await assert.rejects(openPdf(await fixture("used-font-control"),{deadlineMs:1}),/deadline exceeded.*worker terminated/);
	assert.ok(Date.now()-start<2000);
});
test("wasm ceiling is enforced at initialization and after a native rendering allocation",async()=>{
	await assert.rejects(openPdf(await fixture("used-font-control"),{maxWasmBytes:1}),/wasm memory ceiling exceeded/);
	const engine=await openPdf(await fixture("used-font-control"),{maxWasmBytes:24*1024*1024});
	try {
		await assert.rejects(engine.renderPage(1,{height:3200}),/wasm memory ceiling exceeded/);
		await assert.rejects(engine.facts("words"),/worker is closed/);
	}finally{await engine.close();}
});

test("unreliable Unicode never masquerades as extractable text",async()=>{
 await use("unmapped-font",async e=>{
  assert.deepEqual(await e.facts("words"),[]);
  assert.match(e.diagnostics.join("\n"),/omitted 1 characters/);
  assert.deepEqual((await e.pageSpans(1)).spans,[]);
 });
 const report=await checkPdf("test/fixtures/pdf-engine/unmapped-font.pdf",{pdfua:"off",checks:"accessibility,design",maxSparseWords:1});
 assert.ok(report.needsReview.some(r=>r.rule==="text.extractable"));
 assert.ok(report.needsReview.some(r=>r.rule==="text.facts"));
 assert.equal(report.evaluations.find(e=>e.rule==="page.sparse-content")?.outcome,"inapplicable");
});
test("soft masks stay with their raster parent; stencils remain truthful painted raster objects",async()=>{
 for(const name of ["soft-mask","stencil"]) await use(name,async e=>{
  const images=await e.facts("images");assert.equal(images.length,1);
  assert.equal(images[0]!.width,name==="stencil"?8:1);assert.equal(images[0]!.bitsPerPixel,name==="stencil"?1:24);
  assert.equal("type" in images[0]!,false);assert.equal("objectId" in images[0]!,false);
  assert.equal(evaluatePdfPrint({pages:await e.facts("pages"),images,words:[{page:1,text:"Hello"}]},{maxSparseWords:1}).needsReview.filter(r=>r.rule==="page.sparse-content").length,name==="stencil"?1:0);
  assert.ok(ink(await e.renderPage(1,{height:1600}))>0);
 });
});
test("whitespace-separated punctuation counts as a token at an unchanged sparse threshold",async()=>{
 await use("punctuation",async e=>{
  const words=await e.facts("words");assert.deepEqual(words.map(w=>w.text),["Triangle",":","f(x)"]);
  const facts={pages:await e.facts("pages"),images:[],words};
  assert.equal(evaluatePdfPrint(facts,{maxSparseWords:2}).needsReview.length,0);
  assert.equal(evaluatePdfPrint(facts,{maxSparseWords:3}).needsReview.length,1);
 });
});

test("stencil appearance does not remove a sparse-text review candidate",async()=>{
 await use("stencil-text",async e=>{
  const images=await e.facts("images"),words=await e.facts("words");
  assert.equal(images[0]!.colorSpaceKnown,false);assert.deepEqual(words.map(w=>w.text),["Hello"]);
  assert.equal(evaluatePdfPrint({pages:await e.facts("pages"),images,words},{maxSparseWords:1}).needsReview.filter(r=>r.rule==="page.sparse-content").length,1);
 });
});
test("image resolution uses fractional PPI without rounding the caller's threshold",async()=>{
 await use("fractional-ppi",async e=>{
  const image=(await e.facts("images"))[0]!;assert.ok(Math.abs(image.xPpi-150.25)<0.001);
  assert.ok(Math.abs(image.yPpi-150.25)<0.001);
 });
 for(const [threshold,count] of [[150.1,0],[150.3,1]]){
  const report=await checkPdf("test/fixtures/pdf-engine/fractional-ppi.pdf",{checks:"design",minImagePpi:threshold});
  assert.equal(report.needsReview.filter(r=>r.rule==="image.resolution").length,count);
 }
});

test("presentation coordinates clip a CropBox extending outside the MediaBox",async()=>{
 await use("clipped-cropbox",async e=>{
  const page=(await e.facts("pages"))[0]!;assert.deepEqual([page.width,page.height],[200,300]);
  assert.deepEqual(page.boxes.CropBox,[-10,-20,220,330]);
  const word=(await e.facts("words"))[0]!,expected=[20.9,191.384,25.992,8.784];
  word.rect.forEach((n,i)=>assert.ok(Math.abs(n-expected[i]!)<0.1,JSON.stringify(word)));
  const crop=await e.renderPage(1,{dpi:144,rect:{left:20,top:185,width:40,height:25}});assert.ok(ink(crop)>0);
 });
});

test("form values and button captions without saved appearances retain text, fonts and rendered ink",async()=>{
 for(const [name,text] of [["text","Field value"],["choice","One"],["button","Go"]] as const) await use("widget-"+name,async e=>{
  assert.deepEqual((await e.facts("words")).map(w=>w.text),text.split(" "));
  assert.ok((await e.facts("fonts")).some(f=>f.name==="Helvetica"&&!f.embedded));
  assert.ok(ink(await e.renderPage(1,{height:1600}))>0);
  assert.ok((await e.pageSpans(1)).spans.some(s=>s.text.includes(text)));
 });
});
