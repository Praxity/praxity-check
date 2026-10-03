// Development oracle only. Native Poppler is never a product dependency.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { inflateSync } from "node:zlib";
import { openPdf, pdfEngineVersion } from "../src/pdf-engine.ts";
import { evaluatePdfPrint } from "../src/pdf-print.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: "string" }, "poppler-bin": { type: "string" }, corpus: { type: "string" }, sample: { type: "string", default: "150" } } });
if (!values.output || !positionals.length) throw new Error("Usage: node scripts/pdf-engine-parity.mjs --output DIR [--poppler-bin DIR] [--corpus DIR --sample 150] INPUT_DIR...");
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(tmpdir(), "check-engine-parity-"));
const hash = value => createHash("sha256").update(value).digest("hex");
async function pdfs(directory) {
	const result = [];
	for (const e of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name,"en"))) {
		const path = join(directory,e.name);
		if(e.isDirectory()) result.push(...await pdfs(path));
		else if(e.isFile() && /\.pdf$/i.test(e.name)) result.push(path);
	}
	return result;
}
const inputs = (await Promise.all(positionals.map(async dir => (await pdfs(resolve(dir))).map(path => ({ path, set: relative(resolve(dir),path), group: "fixtures" }))))).flat();
if (values.corpus) {
	const root = resolve(values.corpus), groups = [];
	for(const e of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name,"en"))) {
		if(!e.isDirectory() || !/^(PDF_UA-[12]|PDF_A-|ISO 32000-|TWG test files)/.test(e.name)) continue;
		const list = (await pdfs(join(root,e.name))).map(path => ({ path, set: relative(root,path), group: e.name }));
		list.sort((a,b) => hash(a.set).localeCompare(hash(b.set)));
		groups.push(list);
	}
	let selected=0;
	while(selected<Number(values.sample) && groups.some(g=>g.length)) for(const group of groups) if(group.length && selected<Number(values.sample)) {inputs.push(group.shift()); selected++;}
}
const native = (name,args,binary=false) => execFileSync(values["poppler-bin"] ? join(resolve(values["poppler-bin"]), name+(process.platform==="win32"?".exe":"")) : name, args, { timeout: 30000, maxBuffer: 32*1024*1024, encoding: binary ? undefined : "utf8", stdio: ["ignore","pipe","pipe"] });
function poppler(path) {
	const info=native("pdfinfo",[path]), metadata={};
	for(const line of info.split(/\r?\n/)) {const m=line.match(/^([^:]+):\s*(.*)$/); if(m) metadata[m[1]]=m[2];}
	if(metadata.Encrypted?.startsWith("yes")) throw new Error("Encrypted PDFs are not supported.");
	const count=Number(metadata.Pages), box=native("pdfinfo",["-box","-f","1","-l",String(count),path]), pages=[];
	for(let page=1;page<=count;page++) {
		const prefix="^Page\\s+"+page+"\\s+", size=box.match(new RegExp(prefix+"size:\\s+([\\d.]+) x ([\\d.]+)","m"));
		const boxes={};
		for(const name of ["MediaBox","CropBox","BleedBox","TrimBox","ArtBox"]) boxes[name]=box.match(new RegExp(prefix+name+":\\s+([^\\r\\n]+)","m"))?.[1].trim().split(/\s+/).map(Number);
		pages.push({page,width:Number(size?.[1]),height:Number(size?.[2]),rotation:Number(box.match(new RegExp(prefix+"rot:\\s+(-?\\d+)","m"))?.[1]),boxes});
	}
	const fontRows=native("pdffonts",[path]).trim().split(/\r?\n/).slice(2), fonts=fontRows.map(raw=>{
		const m=raw.match(/^(\S+)\s+(.+?)\s+(\S+)\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+(\d+)\s+(\d+)\s*$/);
		if(!m) throw new Error("Unknown oracle font row: "+raw);
		return {name:m[1],type:m[2],encoding:m[3],embedded:m[4]==="yes",subset:m[5]==="yes",unicodeMap:m[6]==="yes",object:m[7]+" "+m[8]};
	});
	const images=native("pdfimages",["-list",path]).trim().split(/\r?\n/).slice(2).filter(Boolean).map(raw=>{
		const c=raw.trim().split(/\s+/), inline=c[10]==="[inline]";
		return {page:Number(c[0]),number:Number(c[1]),type:c[2],width:Number(c[3]),height:Number(c[4]),color:c[5],object:inline?"inline":c[10]+" "+c[11],xPpi:Number(c[inline?11:12]),yPpi:Number(c[inline?12:13])};
	});
	const words=native("pdftotext",["-tsv",path,"-"]).split(/\r?\n/).filter(s=>s.startsWith("5\t")).map(raw=>{
		const c=raw.split("\t"); return {page:Number(c[1]),rect:c.slice(6,10).map(Number),text:c.slice(11).join("\t")};
	});
	return {metadata,pages,fonts,images,words};
}
function rgbPng(bytes) {
	const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20), chunks=[];
	for(let i=8;i<bytes.length;) {const n=bytes.readUInt32BE(i); if(bytes.toString("ascii",i+4,i+8)==="IDAT") chunks.push(bytes.subarray(i+8,i+8+n)); i+=n+12;}
	const scan=inflateSync(Buffer.concat(chunks)), rgb=Buffer.alloc(width*height*3);
	if(bytes[24]!==8 || bytes[25]!==2) throw new Error("Unexpected engine PNG format");
	for(let y=0;y<height;y++){if(scan[y*(width*3+1)]!==0)throw new Error("Unexpected engine PNG filter"); scan.copy(rgb,y*width*3,y*(width*3+1)+1,(y+1)*(width*3+1));}
	return {width,height,rgb};
}
function ppm(bytes) {
	let at=0;
	const token=()=>{while(bytes[at]<=32 || bytes[at]===35) {if(bytes[at]===35)while(bytes[at]!==10)at++;else at++;} const start=at;while(bytes[at]>32)at++;return bytes.toString("ascii",start,at);};
	if(token()!=="P6")throw new Error("Oracle PPM format"); const width=Number(token()),height=Number(token()); if(token()!=="255")throw new Error("Oracle PPM depth"); at++;
	return {width,height,rgb:bytes.subarray(at)};
}
function rasterDiff(a,b) {
	const ink=r=>{let n=0;for(let i=0;i<r.rgb.length;i+=3)if(Math.min(r.rgb[i],r.rgb[i+1],r.rgb[i+2])<250)n++;return n/(r.width*r.height);};
	let sum=0,changed=0;
	for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){const i=(y*a.width+x)*3,j=(Math.min(b.height-1,Math.floor(y*b.height/a.height))*b.width+Math.min(b.width-1,Math.floor(x*b.width/a.width)))*3; let delta=0;for(let c=0;c<3;c++)delta+=Math.abs(a.rgb[i+c]-b.rgb[j+c]);sum+=delta;if(delta>30)changed++;}
	return {before:{width:a.width,height:a.height,inkFraction:ink(a)},after:{width:b.width,height:b.height,inkFraction:ink(b)},meanAbsoluteChannelDifference:sum/(a.width*a.height*3),changedPixelFraction:changed/(a.width*a.height)};
}
const verdict=(facts,threshold)=>evaluatePdfPrint(facts,{maxSparseWords:threshold}).needsReview.map(r=>({rule:r.rule,page:r.location.page,words:r.evidence.wordCount}));
const count=(words,page)=>words.filter(w=>w.page===page).length;
const reports=[], classes={};
try {
	for(const [index,input] of inputs.entries()) {
		const bytes=await readFile(input.path), report={...input,sha256:hash(bytes),differences:[]}, add=(kind,detail)=>{report.differences.push({kind,detail});classes[kind]=(classes[kind]??0)+1;};
		let before, engine;
		try {before=poppler(input.path);report.before=before;}catch(e){report.beforeError=e.message;}
		try {
			engine=await openPdf(bytes);const after={metadata:engine.metadata};
			for(const kind of ["pages","fonts","images","words"])try{after[kind]=await engine.facts(kind);}catch(e){after[kind+"Error"]=e.message;add("engine-inventory-error",{kind,error:e.message});}
			report.after=after;
			if(before) {
				if(before.pages.length!==after.pages?.length)add("page-count",{before:before.pages.length,after:after.pages?.length});
				for(const key of ["Pages","Title","Author","Subject","Keywords","Creator","Producer","CreationDate","ModDate","Encrypted","Tagged"])if((before.metadata[key]??"")!==(after.metadata[key]??""))add("metadata",{key,before:before.metadata[key],after:after.metadata[key]});
				for(const a of after.pages??[]) {const b=before.pages[a.page-1];if(!b)continue;for(const key of Object.keys(a.boxes))if(a.boxes[key].some((n,i)=>Math.abs(n-b.boxes[key][i])>0.02))add("page-box",{page:a.page,key,before:b.boxes[key],after:a.boxes[key]});if(a.rotation!==b.rotation)add("rotation",{page:a.page,before:b.rotation,after:a.rotation});if(Math.abs(a.width-b.width)>0.02||Math.abs(a.height-b.height)>0.02)add("presentation-size",{page:a.page,before:[b.width,b.height],after:[a.width,a.height]});}
				const f=fonts=>fonts.map(v=>[v.name,v.embedded]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
				if(after.fonts&&JSON.stringify(f(before.fonts))!==JSON.stringify(f(after.fonts)))add("font-inventory",{before:before.fonts,after:after.fonts});
				if(after.images) {
					if(before.images.length!==after.images.length)add("image-row-count",{before:before.images,after:after.images});
					const painted=before.images.filter(i=>i.type!=="smask"&&i.type!=="mask");
					for(const [i,a] of after.images.entries()){const b=painted[i];if(!b||a.width!==b.width||a.height!==b.height||Math.abs(a.xPpi-b.xPpi)>1||Math.abs(a.yPpi-b.yPpi)>1)add("image-facts",{before:b,after:a});}
				}
				if(after.words) {
					report.wordCounts=before.pages.map(p=>({page:p.page,before:count(before.words,p.page),after:count(after.words,p.page)}));
					for(const c of report.wordCounts)if(c.before!==c.after)add("word-count",c);
					const text=words=>words.map(w=>w.text).join(" ");
					if(text(before.words)!==text(after.words))add("word-text",{before:text(before.words),after:text(after.words)});
					const diffs=[];
					for(const [i,a] of after.words.entries()){const b=before.words[i];if(b?.text===a.text&&b.page===a.page&&a.rect.some((n,k)=>Math.abs(n-b.rect[k])>2))diffs.push({page:a.page,text:a.text,before:b.rect,after:a.rect});}
					if(diffs.length)add("word-box",{tolerancePoints:2,count:diffs.length,examples:diffs.slice(0,20)});
					if(after.images&&after.pages)for(const threshold of [1,5,20]){const b=verdict(before,threshold),a=verdict(after,threshold);if(JSON.stringify(b)!==JSON.stringify(a))add("print-verdict",{threshold,before:b,after:a});}
				}
				report.design=[];report.renders=[];
				for(const page of after.pages??[]) {
					try {
						const xml=native("pdftohtml",["-q","-xml","-i","-stdout","-zoom","1","-noroundcoord","-f",String(page.page),"-l",String(page.page),input.path]);
						const spans=[...xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map(m=>({attributes:m[1],bold:/<b(?:>|\s)/.test(m[2]),italic:/<i(?:>|\s)/.test(m[2]),text:m[2].replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")}));
						const fonts=[...xml.matchAll(/<fontspec\b([^>]+)\/>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(m=>[m[1],m[2]])));
						const afterSpans=await engine.pageSpans(page.page);
						const matchedDifferences=[];
						for(const span of spans){
							const attrs=Object.fromEntries([...span.attributes.matchAll(/(\w+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
							const next=afterSpans.spans.find(s=>s.text.trim()===span.text.trim()),oldFont=fonts.find(f=>f.id===attrs.font);
							if(!next||!oldFont)continue;
							const nextFont=afterSpans.fonts.find(f=>f.id===next.font),beforeRect=["left","top","width","height"].map(k=>Number(attrs[k])),afterRect=[next.left,next.top,next.width,next.height];
							if(Math.abs(Number(oldFont.size)-nextFont.sizePt)>0.05||oldFont.family!==nextFont.family||oldFont.color.toLowerCase()!==nextFont.color.toLowerCase()||span.bold!==next.bold||span.italic!==next.italic||beforeRect.some((n,i)=>Math.abs(n-afterRect[i])>2))matchedDifferences.push({text:span.text,before:{font:oldFont,bold:span.bold,italic:span.italic,rect:beforeRect},after:{font:nextFont,bold:next.bold,italic:next.italic,rect:afterRect}});
						}
						report.design.push({page:page.page,before:{fonts,spans},after:afterSpans,matchedDifferences});
						if(matchedDifferences.length||spans.map(s=>s.text).join(" ").trim()!==afterSpans.spans.map(s=>s.text).join(" ").trim()||fonts.map(f=>Number(f.size)).sort().join(",")!==afterSpans.fonts.map(f=>f.sizePt).sort().join(","))add("design-spans",{page:page.page,beforeSpanCount:spans.length,afterSpanCount:afterSpans.spans.length,beforeFonts:fonts,afterFonts:afterSpans.fonts,matchedDifferences:matchedDifferences.slice(0,20),boxTolerancePoints:2});
					}catch(e){add("design-error",{page:page.page,error:e.message});}
					try {
						const prefix=join(work,"render");
						native("pdftoppm",["-f",String(page.page),"-l",String(page.page),"-singlefile","-cropbox","-scale-to-y","1600","-scale-to-x","-1",input.path,prefix]);
						const a=ppm(await readFile(prefix+".ppm")),b=rgbPng(await engine.renderPage(page.page,{height:1600})), diff=rasterDiff(a,b);
						report.renders.push({page:page.page,...diff});
						if(a.width!==b.width||a.height!==b.height)add("render-size",{page:page.page,before:[a.width,a.height],after:[b.width,b.height]});
						if(diff.changedPixelFraction>0.0001)add("render-pixels",{page:page.page,...diff});
					}catch(e){add("render-error",{page:page.page,error:e.message});}
				}
			} else add("open-difference",{before:report.beforeError,after:"opened"});
		}catch(e){report.afterError=e.message;if(!report.beforeError)add("open-difference",{before:"opened",after:e.message});}
		finally {await engine?.close();}
		reports.push(report);
		await writeFile(join(output,"progress.json"),JSON.stringify({completed:index+1,total:inputs.length,last:input.set,classes},null,2));
		if((index+1)%10===0)console.log((index+1)+"/"+inputs.length+" PDFs");
	}
	const summary={engine:pdfEngineVersion,files:reports.length,corpusFiles:reports.filter(r=>r.group!=="fixtures").length,classes,inputs:reports.map(r=>({path:r.path,sha256:r.sha256,group:r.group}))};
	await writeFile(join(output,"diff.json"),JSON.stringify({summary,reports},null,2));
	await writeFile(join(output,"diff.md"),"# PDF engine parity\n\nCompared "+reports.length+" PDFs, including "+summary.corpusFiles+" corpus files.\n\n| Difference class | Occurrences |\n| --- | ---: |\n"+Object.entries(classes).map(([k,n])=>"| "+k+" | "+n+" |").join("\n")+"\n\nFull facts, words, design spans and per-page render statistics: diff.json.\n");
	console.log(JSON.stringify(summary));
} finally {await rm(work,{recursive:true,force:true});}
