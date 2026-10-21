import test from 'node:test';
import assert from 'node:assert/strict';
import { screenSolicitation } from '../src/triage.js';

test('screens a vendor or recruitment pitch that shows no procurement signal', () => {
  const pitch = 'We noticed your group has been expanding. We have a pre-vetted pool of candidates and our staffing team can scale up your team.';
  const result = screenSolicitation(pitch);
  assert.equal(result.solicitation, true);
  assert.match(result.reason, /solicitation/);
});

test('never screens a message that names quantities of goods', () => {
  assert.equal(screenSolicitation('Urgent: need Filter-A10 - 300 units, send price and stock').solicitation, false);
  assert.equal(screenSolicitation('采购确认：Filter A10 40 件，请提供报价与库存').solicitation, false);
});

test('a pitch that also asks for goods is a real request', () => {
  assert.equal(screenSolicitation('Our agency specialises in talent. Also please quote 12 units of FILTER-A10').solicitation, false);
});

test('an ordinary inquiry passes through', () => {
  assert.equal(screenSolicitation('Could you send a quotation for the filters we discussed?').solicitation, false);
});
