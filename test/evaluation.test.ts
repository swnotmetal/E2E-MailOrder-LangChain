import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { extractionScores, readCandidateFixture, readEvaluationFixture } from '../src/evaluation.js';

test('multilingual regression fixture is human-confirmed and deterministic evaluators expose regressions',async()=>{
  const fixture=await readEvaluationFixture(resolve('fixtures/evaluation/multilingual-inquiries.json'));
  assert.equal(fixture.humanVerified,true);assert.equal(fixture.cases.length,9);
  assert.deepEqual(fixture.cases.slice(0,4).map(c=>c.expected.language).sort(),['de','en','et','fi']);
  for(const item of fixture.cases) {
    const perfect=extractionScores({...item.expected,status:'ok',evidenceValid:true},item.expected);
    assert.equal(perfect.regression_pass,1);
    if(item.historical) {
      const historical=extractionScores(item.historical,item.expected);
      if(item.id==='helsinki-fi'){assert.equal(historical.intent_match,0);assert.equal(historical.lines_match,1);}
      else assert.equal(historical.regression_pass,0);
    }
  }
  const promoted=fixture.cases.find(c=>c.id==='apex-stock-check');
  assert.deepEqual(promoted?.expected.date,['late November']);assert.deepEqual(promoted?.expected.address,[]);
  assert.equal(fixture.cases.find(c=>c.id==='solarvolt-spec-approval')?.expected.language,'en');
});

test('English candidate fixture remains unlabeled until a human reviews model proposals',async()=>{
  const fixture=await readCandidateFixture(resolve('fixtures/evaluation/english-candidates.json'));
  assert.equal(fixture.humanVerified,false);assert.equal(fixture.cases.length,5);
  assert.deepEqual(fixture.cases.map(c=>c.id),['apex-stock-check','nippon-po-2026-99482','berlin-revised-quote','outback-stock','solarvolt-spec-approval']);
  assert.ok(fixture.cases.every(c=>c.inputs.sources.every(source=>source.source==='email'&&source.text.includes('Subject:'))));
});
