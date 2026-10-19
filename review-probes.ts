import { chromium } from 'playwright';
import { keyboardWalk, scopeCoverage } from './src/checks.ts';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch();
const rows: unknown[] = [];
const buttons = (n: number) => Array.from({length:n}, (_,i)=>`<button id="b${i}">Button ${i}</button>`).join('');
const block = `<script>document.querySelector('#trap').onkeydown=e=>{if(e.key==='Tab')e.preventDefault()}</script>`;
const cases: Record<string,string> = {
 keydown: `<button>Before</button><button id="trap">Trap</button><button>After</button>${block}`,
 blur: `<button>Before</button><button id="trap">Trap</button><button>After</button><script>trap.onblur=()=>trap.focus()</script>`,
 modal: `<button id="outside">Outside</button><div role="dialog" aria-modal="true"><button id="a">A</button><button id="b">B</button></div><script>document.onkeydown=e=>{if(e.key==='Tab'){e.preventDefault();(document.activeElement===a?b:a).focus()}};document.onkeydownEscape=()=>{}</script>`,
 shadow: `<button>Before</button><div id="host"></div><button>After</button><script>host.attachShadow({mode:'open'}).innerHTML='<button id="trap">Trap</button>';host.shadowRoot.querySelector('button').onkeydown=e=>{if(e.key==='Tab')e.preventDefault()}</script>`,
 iframe: `<button>Before</button><iframe srcdoc="<button onkeydown=&quot;if(event.key==='Tab')event.preventDefault()&quot;>Trap</button>"></iframe><button>After</button>`,
 'shadow-only': `<div id="host"></div><script>host.attachShadow({mode:'open'}).innerHTML='<button id="trap">Trap</button>';host.shadowRoot.querySelector('button').onkeydown=e=>{if(e.key==='Tab')e.preventDefault()}</script>`,
 'iframe-only': `<iframe srcdoc="<button onkeydown=&quot;if(event.key==='Tab')event.preventDefault()&quot;>Trap</button>"></iframe>`,
 'release-30': `<button>Before</button><button id="trap">Trap</button><button>After</button><script>let n=0;trap.onkeydown=e=>{if(e.key==='Tab'&&++n<30)e.preventDefault()}</script>`,
 select: `<button>Before</button><select><option>A</option><option>B</option></select><button>After</button>`,
 details: `<button>Before</button><details open><summary>Details</summary><button>Inside</button></details><button>After</button>`,
 contenteditable: `<button>Before</button><div contenteditable>Edit me</div><button>After</button>`,
 'two-traps': `<input type="datetime-local"><button>Between</button><button id="trap">Trap</button><button id="trap2">Trap 2</button><button>After</button><script>for(const el of [trap,trap2])el.onkeydown=e=>{if(e.key==='Tab')e.preventDefault()}</script>`,
 'six-traps': `${buttons(6)}<script>document.querySelectorAll('button').forEach(el=>el.onkeydown=e=>{if(e.key==='Tab')e.preventDefault()})</script>`,
 'probe-arms-trap': `<button>Before</button><input id="schedule" type="datetime-local"><button id="after">After</button><script>after.onfocus=()=>{schedule.onkeydown=e=>{if(e.key==='Tab')e.preventDefault()}}</script>`,
 'probe-removes-target': `<button>Before</button><input id="schedule" type="datetime-local"><button id="after">After</button><button id="trap">Trap</button>${block}<script>after.onfocus=()=>schedule.remove()</script>`,
 'focus-loop-200': `${buttons(200)}<script>document.onkeydown=e=>{if(e.key==='Tab'&&!e.shiftKey&&document.activeElement===b199){e.preventDefault();b0.focus()}}</script>`,
 'plain-500': buttons(500),
 'native-200': Array.from({length:200},(_,i)=>`<input id="date${i}" type="datetime-local">`).join(''),
 'focus-loop-500-slow': `${buttons(500)}<script>document.onkeydown=e=>{const end=performance.now()+10;while(performance.now()<end){};if(e.key==='Tab'&&!e.shiftKey&&document.activeElement===b499){e.preventDefault();b0.focus()}}</script>`,
};
for (const type of ['date','time','datetime-local','month','week']) cases[type]=`<button>Before</button><input type="${type}"><button>After</button>`;
for (const tag of ['audio','video']) cases[tag]=`<button>Before</button><${tag} controls></${tag}><button>After</button>`;
for (const [name,html] of Object.entries(cases)) {
 const page=await browser.newPage(); page.setDefaultTimeout(1500);
 await page.setContent(html); await page.waitForLoadState();
 await page.evaluate(()=>{(globalThis as any).focusLog=[];document.addEventListener('focusin',e=>(globalThis as any).focusLog.push((e.target as HTMLElement).id||(e.target as HTMLElement).tagName))});
 let presses=0;const press=page.keyboard.press.bind(page.keyboard);page.keyboard.press=async (...args)=>{presses++;return press(...args)};
 const start=performance.now(); let result;
 try { result=await keyboardWalk(page,name); }catch(e){result={error:String(e)}}
 const row={name,ms:Math.round(performance.now()-start),presses,result,focusLog:await page.evaluate(()=>(globalThis as any).focusLog),scope:(await scopeCoverage(page,name)).untested};
 rows.push(row);console.log(JSON.stringify(row));await page.close();
}
await browser.close();
await writeFile(process.env.PROBE_OUTPUT||'review-head.json',JSON.stringify(rows,null,2));
