// Fixture generation adapter. Product operations use the same owning engine.
import {readFile,writeFile} from "node:fs/promises";
import {openPdf} from "../src/pdf-engine.ts";
const [operation,input,prefix]=process.argv.slice(2);
if(!["facts","render"].includes(operation)||!input||operation==="render"&&!prefix)throw new Error("Usage: node scripts/pdf-benchmark.mjs facts PDF | render PDF OUTPUT_PREFIX");
const engine=await openPdf(await readFile(input));
try{
	const pages=await engine.facts("pages");
	if(operation==="facts")console.log(JSON.stringify({pageCount:pages.length,words:await engine.facts("words")}));
	else for(const page of pages)await writeFile(prefix+"-"+page.page+".png",await engine.renderPage(page.page,{height:1400}));
}finally{await engine.close();}
