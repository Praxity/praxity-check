import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
mkdirSync('review-evidence',{recursive:true});
const original=readFileSync('src/checks.ts');
const base=execFileSync('git',['show','993069cce90a72fc93f5e78796f88b4b65e2d293:src/checks.ts']);
try {
 for(const variant of ['head','base']) {
  writeFileSync('src/checks.ts',variant==='head'?original:base);
  const tests=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern=keyboardWalk','test/checks.test.ts'],{encoding:'utf8'});
  writeFileSync(`review-evidence/${variant}-existing.tap`,tests.stdout+tests.stderr);
  console.log(`${variant} existing keyboardWalk tests exit=${tests.status}`);
  const probes=spawnSync(process.execPath,['review-probes.ts'],{encoding:'utf8',env:{...process.env,PROBE_OUTPUT:`review-evidence/${variant}.json`}});
  writeFileSync(`review-evidence/${variant}-probes.log`,probes.stdout+probes.stderr);
  console.log(`${variant} exploratory probes exit=${probes.status}`);
  if(probes.status!==0)throw new Error(probes.stderr);
 }
}finally {writeFileSync('src/checks.ts',original)}
const head=JSON.parse(readFileSync('review-evidence/head.json','utf8'));
const baseline=JSON.parse(readFileSync('review-evidence/base.json','utf8'));
for(const h of head){const b=baseline.find(x=>x.name===h.name);console.log(JSON.stringify({name:h.name,head:{presses:h.presses,ms:h.ms,findings:h.result.findings?.length,error:h.result.error},base:{presses:b.presses,ms:b.ms,findings:b.result.findings?.length,error:b.result.error}}))}
