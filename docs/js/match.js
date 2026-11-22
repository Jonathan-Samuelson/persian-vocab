// Lenient answer checking for the typing mode.
// 1. Normalize both strings (script-specific: Persian, Hebrew, Latin transliteration).
// 2. Compare with Damerau-Levenshtein distance, which counts a swap of two
//    neighbouring letters as one mistake.
// 3. Allow more mistakes in longer words.
(function (root) {
  const FA_MAP = { 'ي': 'ی', 'ى': 'ی', 'ئ': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ؤ': 'و' };
  const HE_FINAL = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

  function normFa(s) {
    return s
      .replace(/[ً-ٰٟـ‌‍‏‎]/g, '') // harakat, tatweel, ZWNJ, marks
      .replace(/[يىئكةۀأإآٱؤ]/g, c => FA_MAP[c])
      .replace(/[\s\-_.،,!?؟]/g, '');
  }
  function normHe(s) {
    return s
      .replace(/[֑-ׇ]/g, '')                 // nikud and cantillation
      .replace(/[ךםןףץ]/g, c => HE_FINAL[c])
      .replace(/["'״׳`]/g, '')
      .replace(/[\s\-_.,!?;:]/g, '');
  }
  function normLatin(s) {
    return s.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')  // ā -> a
      .replace(/[‘’'`ʿʾ]/g, '')
      .replace(/[\s\-_.,!?]/g, '')
      .replace(/kh/g, 'x').replace(/gh/g, 'q').replace(/sh/g, 's').replace(/ch/g, 'c').replace(/zh/g, 'j')
      .replace(/w/g, 'v').replace(/ou|oo/g, 'u').replace(/ee/g, 'i').replace(/(.)\1/g, '$1');
  }
  function script(s) {
    if (/[؀-ۿ]/.test(s)) return 'fa';
    if (/[֐-׿]/.test(s)) return 'he';
    return 'latin';
  }
  function norm(s) {
    const t = script(s);
    return t === 'fa' ? normFa(s) : t === 'he' ? normHe(s) : normLatin(s);
  }

  // Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps).
  function distance(a, b) {
    const n = a.length, m = b.length;
    if (!n) return m; if (!m) return n;
    const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r; });
    for (let j = 0; j <= m; j++) d[0][j] = j;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[n][m];
  }

  // How many mistakes a word of this length may have and still count.
  // Up to 3 letters must be exact (one changed letter usually makes another word).
  function allowed(len) { return len <= 3 ? 0 : len <= 5 ? 1 : len <= 9 ? 2 : 3; }

  // Split a stored answer such as "מדינה / ארץ" or "אדיב, נחמד (מנומס)" into accepted variants.
  function variants(answer) {
    const out = new Set();
    const add = v => { v = v.trim(); if (v) out.add(v); };
    add(answer);
    const noParen = answer.replace(/\([^)]*\)/g, ' ');
    add(noParen);
    noParen.split(/[\/,;]| או /).forEach(add);
    // Hebrew: accept with or without the definite article / infinitive lamed.
    for (const v of Array.from(out)) {
      if (/^ה[א-ת]{2,}/.test(v)) add(v.slice(1));
      if (/^ל[א-ת]{2,}/.test(v)) add(v.slice(1));
    }
    return Array.from(out);
  }

  // Returns { verdict: 'exact' | 'close' | 'wrong', best: the variant closest to the input }
  function check(input, answers) {
    const typed = norm(String(input || ''));
    if (!typed) return { verdict: 'wrong', best: answers[0] };
    let best = null, bestD = Infinity, bestTarget = '';
    for (const a of answers) for (const v of variants(a)) {
      const t = norm(v);
      if (!t) continue;
      let dd = distance(typed, t);
      if (/^ה/.test(typed) && script(input) === 'he') dd = Math.min(dd, distance(typed.slice(1), t));
      if (dd < bestD) { bestD = dd; best = v; bestTarget = t; }
    }
    if (bestD === 0) return { verdict: 'exact', best };
    if (bestD <= allowed(bestTarget.length)) return { verdict: 'close', best, mistakes: bestD };
    return { verdict: 'wrong', best: answers[0] };
  }

  root.Match = { check, distance, norm, variants };
  if (typeof module !== 'undefined') module.exports = root.Match;
})(typeof window !== 'undefined' ? window : globalThis);
