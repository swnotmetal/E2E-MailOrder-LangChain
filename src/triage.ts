// Deterministic pre-screen, run before any model call so a rejected message costs nothing.
//
// Deliberately keyword-based rather than a classifier: AGENTS.md fixes the application to a single
// model (gemini-2.5-flash-lite), so adding another model or provider is not an option here. The
// rules are conservative in one direction only — they block a message that looks like a vendor or
// recruitment pitch AND shows no procurement signal at all. Anything that names quantities of goods
// is treated as a real request whatever else it says.

const SOLICITATION = [
  /\bcandidates?\b/i, /\brecruit/i, /\bstaffing\b/i, /\btalent\b/i, /\bblind profiles?\b/i,
  /\bpre-?vetted\b/i, /\boutsourc/i, /\bstaffing solutions\b/i, /\bour (services|team) (offer|provide)/i,
  /\bwe speciali[sz]e in\b/i, /\bwe are (a|an) (supplier|manufacturer|provider|agency)\b/i,
  /\bpartnership proposal\b/i, /\bscale up (your|our) team\b/i,
];

const PROCUREMENT = [
  /\brfq\b/i, /\bquot(e|ation)\b/i, /\boffer\b/i, /\bprice\b/i, /\bstock\b/i, /\bavailab/i,
  /\bdeliver/i, /\bpurchase\b/i, /\border\b/i, /\binvoice\b/i,
  /anfrage/i, /angebot/i, /preis/i, /liefer/i, /bestellung/i,
  /采购|询价|报价|订单|库存|供货|交货/,
  /استفسار|عرض سعر|طلب|سعر|مخزون/,
];

// A quantity attached to a unit is the strongest signal that someone wants goods.
const QUANTITY = /\d[\d.,]*\s*(units?|pcs|pieces?|sets?|st(ü|u)ck|件|个|台|盒|套|unités?)/i;

export function screenSolicitation(text: string): { solicitation: boolean; reason: string } {
  if (QUANTITY.test(text)) return { solicitation: false, reason: '' };
  const solicitation = SOLICITATION.filter(pattern => pattern.test(text)).length;
  const procurement = PROCUREMENT.filter(pattern => pattern.test(text)).length;
  if (solicitation >= 2 && procurement === 0) {
    return { solicitation: true, reason: `${solicitation} solicitation marker(s), no procurement signal` };
  }
  return { solicitation: false, reason: '' };
}
