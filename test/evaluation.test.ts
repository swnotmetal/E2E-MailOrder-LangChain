import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { extractionScores, readEvaluationFixture } from '../src/evaluation.js';

test('multilingual regression fixture is human-confirmed and deterministic evaluators expose regressions',async()=>{
  const fixture=await readEvaluationFixture(resolve('fixtures/evaluation/multilingual-inquiries.json'));
  assert.equal(fixture.humanVerified,true);assert.equal(fixture.cases.length,4);
  assert.deepEqual(fixture.cases.map(c=>c.expected.language).sort(),['de','en','et','fi']);
  for(const item of fixture.cases) {
    const perfect=extractionScores({...item.expected,status:'ok',evidenceValid:true},item.expected);
    assert.equal(perfect.regression_pass,1);
    const historical=extractionScores(item.historical,item.expected);
    if(item.id==='helsinki-fi'){assert.equal(historical.intent_match,0);assert.equal(historical.lines_match,1);}
    else assert.equal(historical.regression_pass,0);
  }
});
