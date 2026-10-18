// Node 24's native type stripping loads the UI's actual display formatter.
import assert from 'node:assert/strict';
import { formatColumnNumber } from './group-presentation.ts';
const examples = [
  [1500, {}, '1,500'], [1500, {format:'USD'}, '$1,500.00'], [1500, {format:'KHR'}, '៛1,500'],
  [25, {format:'PERCENT'}, '25%'], [.25, {format:'PERCENT'}, '0.25%'],
  [1500, {format:'CUSTOM',prefix:'qty ',suffix:' kg',grouping:false}, 'qty 1500 kg'],
  [12.345, {format:'USD',decimals:1}, '$12.3'], [0, {format:'USD'}, '$0.00'],
  [null, {format:'USD'}, ''], [{error:'#DIV/0!'}, {format:'USD'}, '#DIV/0!'], [true, {format:'USD'}, 'TRUE'],
];
for (const [raw, settings, display] of examples) {
  const before = JSON.stringify([raw, settings]);
  assert.equal(formatColumnNumber(raw, settings), display);
  assert.equal(JSON.stringify([raw, settings]), before);
}
console.log(`${examples.length} display-format cases passed; raw values and settings unchanged.`);
