// A small language detector for browsers without one built in (Chrome has LanguageDetector).
// It only needs to tell apart the languages the translation models cover: the script first
// (Han, kana, Hangul, Cyrillic, Arabic, Devanagari), then common words for Latin-script text.
// It answers in the LanguageDetector shape: [{ detectedLanguage, confidence }], best first.

const WORDS = {
  en: 'the and is are was you i to of a in it that for on with this be have do not what how see tomorrow hey hi thanks thank yes no will can my your we me just so',
  es: 'el la los las de que y en un una es por para con no se lo como cómo estás está qué hola gracias mañana nos vemos pero muy sí bien yo tú te hasta luego',
  fr: 'le la les de des et est un une que qui pour pas ne je tu vous nous il elle ça va comment bonjour salut merci demain se voit on avec dans oui mais très',
  de: 'der die das und ist nicht ich du sie wir es ein eine zu mit auf für wie geht dir hallo danke morgen sehen uns ja nein aber sehr bis',
  it: 'il lo la gli le di che e è un una per non sono come stai ciao grazie domani ci vediamo anche ma sì io tu molto bene',
  nl: 'de het een en is niet ik je jij we zijn van op voor met hoe gaat hallo dank bedankt morgen tot ziens ja nee maar heel',
  pt: 'o a os as de que e é um uma não com para como você está obrigado obrigada olá amanhã até sim mas eu muito tudo bem',
  sv: 'och att det är en ett jag du vi inte på med för hur mår hej tack imorgon ses ja nej men mycket bra',
  pl: 'i w nie się na że to jest jak co ja ty my dzięki cześć jutro do zobaczenia tak bardzo dobrze',
  tr: 've bir bu da de ne ben sen biz değil için nasılsın merhaba teşekkürler yarın görüşürüz evet hayır ama çok iyi',
  id: 'dan yang di ke dari ini itu tidak saya kamu kita apa kabar halo terima kasih besok sampai jumpa ya sangat baik',
  vi: 'và là của có không tôi bạn chúng ta này đó xin chào cảm ơn ngày mai hẹn gặp lại rất tốt',
};
const LISTS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));
// letters that settle it among Latin-script languages
const MARKS = [
  [/[ơưăđ]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i, 'vi'],
  [/[łśźżąęń]/i, 'pl'],
  [/[ığş]/i, 'tr'],
  [/[ñ¿¡]/i, 'es'],
  [/[ß]/i, 'de'],
  [/[ãõ]/i, 'pt'],
  [/[åø]/i, 'sv'],
];

const count = (re, s) => (s.match(re) || []).length;

/** [{ detectedLanguage, confidence }] for `text`; 'und' when it can't tell. */
export function detectLanguage(text) {
  const s = String(text || '').slice(0, 2000);
  const letters = count(/\p{L}/gu, s);
  if (!letters) return [{ detectedLanguage: 'und', confidence: 0 }];
  const share = (re) => count(re, s) / letters;
  const sure = (lang, c) => [{ detectedLanguage: lang, confidence: c }];
  if (share(/\p{Script=Hangul}/gu) > 0.3) return sure('ko', 0.95);
  if (share(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) > 0.1) return sure('ja', 0.95);
  if (share(/\p{Script=Han}/gu) > 0.3) return sure('zh', 0.9);
  if (share(/\p{Script=Arabic}/gu) > 0.3) return sure('ar', 0.9);
  if (share(/\p{Script=Devanagari}/gu) > 0.3) return sure('hi', 0.9);
  if (share(/\p{Script=Cyrillic}/gu) > 0.3) return /[іїєґІЇЄҐ]/u.test(s) ? sure('uk', 0.9) : sure('ru', 0.85);
  if (share(/\p{Script=Latin}/gu) < 0.5) return [{ detectedLanguage: 'und', confidence: 0 }];

  const words = s.toLowerCase().match(/\p{L}+/gu) || [];
  const scores = Object.fromEntries(Object.keys(LISTS).map((k) => [k, 0]));
  for (const w of words) for (const [k, set] of Object.entries(LISTS)) if (set.has(w)) scores[k] += 1;
  for (const [re, lang] of MARKS) if (re.test(s)) scores[lang] += 2;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [[, s1], [, s2]] = ranked;
  if (!s1) return [{ detectedLanguage: 'und', confidence: 0 }];
  // clearly ahead of the runner-up, with a few hits: sure; one stray word: not
  const confidence = s1 >= 2 && s1 >= 2 * s2 ? 0.9 : s1 > s2 && words.length <= 4 ? 0.75 : s1 > s2 ? 0.7 : 0.4;
  return ranked.filter(([, v]) => v > 0).slice(0, 3)
    .map(([lang, v], i) => ({ detectedLanguage: lang, confidence: i === 0 ? confidence : Math.min(0.5, v / Math.max(1, words.length)) }));
}
