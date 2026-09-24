'use strict';
/*
 * Cloudflare Workers AI "neurons" guard. The free allowance is 10,000 neurons per UTC day and every
 * generation call spends some of it, so this module keeps a running (deliberately pessimistic)
 * estimate per account per UTC day in .neuron_usage.json and REFUSES to start a call that would take
 * the day's total past the safety ceiling - we never run the account dry.
 *
 * Prices used (Cloudflare docs, rounded UP with a safety factor):
 *   llama-3.3-70b-instruct-fp8-fast   26,668 neurons / M input tokens,  204,805 / M output tokens
 *   llama-3.1-8b-instruct-fp8-fast     4,119 / M input,                  34,868 / M output
 *   flux-1-schnell (1024x1024)        ~60 neurons at 4 steps -> budgeted at 120 per image
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '.neuron_usage.json');
const DAILY_CEILING = +process.env.NEURON_DAILY_CEILING || 6000;   // hard stop well under the 10,000 allowance
const PER_RUN_CEILING = +process.env.NEURON_RUN_CEILING || 700;    // ONE FILM MAY NEVER COST MORE THAN THIS (estimated, then settled to the measured figure)
const SAFETY = 1.15;
const RATE = { '70b': [26668, 204805], mistral: [31909, 50455], '8b': [4119, 34868] };

const day = () => new Date().toISOString().slice(0, 10);
const who = () => crypto.createHash('sha1').update(String(process.env.CLOUDFLARE_ACCOUNT_ID || '')).digest('hex').slice(0, 10);
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; } };
const save = (o) => { try { fs.writeFileSync(FILE, JSON.stringify(o)); } catch (_) { /* best effort */ } };

const estText = (model, inChars, outTokens) => {
  const r = /70b/i.test(model) ? RATE['70b'] : /mistral/i.test(model) ? RATE.mistral : RATE['8b'];
  return Math.ceil(((inChars / 3.2) * r[0] + outTokens * r[1]) / 1e6 * SAFETY);
};
const FLUX_STEPS = +process.env.FLUX_STEPS || 2;
const estImage = (steps = FLUX_STEPS) => Math.ceil(44.8 * steps + 2);   // MEASURED on a real dashboard: 7 images x 3 steps = 940.8 neurons -> 44.8 per step

let runSpent = 0;
function used() { const u = load(); return (u[who()] && u[who()].day === day()) ? u[who()].n : 0; }

/** Call BEFORE spending: throws if this would cross the per-run or daily ceiling; otherwise records the estimate. */
function charge(neurons, what, reserve = 0) {
  if (runSpent + neurons + reserve > PER_RUN_CEILING) throw new Error(`Neuron guard: ${what} would take this run to ~${runSpent + neurons} neurons (run ceiling ${PER_RUN_CEILING}). Stopped before spending.`);
  const u = load(), k = who(), cur = (u[k] && u[k].day === day()) ? u[k].n : 0;
  if (cur + neurons > DAILY_CEILING) throw new Error(`Neuron guard: ${what} would take today's estimated total to ~${cur + neurons} of the ${DAILY_CEILING} safety ceiling (free allowance 10,000). Stopped before spending.`);
  u[k] = { day: day(), n: cur + neurons }; save(u); runSpent += neurons;
  console.log(`[neurons] ${what}: ~${neurons} (run ~${runSpent}, today ~${cur + neurons} of ${DAILY_CEILING} ceiling)`);
}
const resetRun = () => { runSpent = 0; };

/** After a text call: replace the estimate with what the API says it really used (tokens in / out). */
function settleText(model, estimated, usage, what) {
  if (!usage) return;
  const r = /70b/i.test(model) ? RATE['70b'] : /mistral/i.test(model) ? RATE.mistral : RATE['8b'];
  const real = Math.ceil(((usage.prompt_tokens || 0) * r[0] + (usage.completion_tokens || 0) * r[1]) / 1e6);
  const diff = estimated - real, u = load(), k = who();
  if (u[k]) { u[k].n = Math.max(0, u[k].n - diff); save(u); }
  runSpent = Math.max(0, runSpent - diff);
  console.log(`[neurons] ${what}: measured ${real} (${usage.prompt_tokens} in / ${usage.completion_tokens} out tokens); run now ~${runSpent}`);
}
const runTotal = () => runSpent;
module.exports = { FLUX_STEPS, charge, settleText, estText, estImage, used, resetRun, runTotal, DAILY_CEILING, PER_RUN_CEILING };
