/**
 * UI strings. Score data (names, phases) comes from the engine; only chrome is translated.
 * Add a language by adding a column — keys missing in a language fall back to English.
 */
const STRINGS = {
  en: {
    live: 'Live', final: 'Final', upcoming: 'Up next', vs: 'vs', serving: 'Serving', court: 'Court',
    connecting: 'Connecting', reconnecting: 'Reconnecting — showing last known score', offline: 'Offline — showing last known score',
    pairTitle: 'Pair this screen', pairHelp: 'In the organizer console, open Screens → Pair a screen and enter this code, or scan the QR code with a signed-in phone.',
    pairExpires: 'Code refreshes automatically', idle: 'Waiting for a match to be assigned', standings: 'Standings', results: 'Results',
    noCourtMatch: 'No match on this court', sponsors: 'With thanks to our partners', played: 'P', won: 'W', drawn: 'D', lost: 'L', pts: 'Pts',
    scanToWatch: 'Scan to follow live',
    presentedBy: 'presented by', sponsoredBy: 'Sponsored by', poweredBy: 'Powered by', timeoutBy: 'Timeout brought to you by', matchSponsor: "Today's match sponsor",
    potm: 'Player of the Match', broughtToYouMatch: 'This match is brought to you by', broughtToYou: 'Brought to you by', sponsorsLabel: 'Sponsors',
  },
  hi: {
    live: 'लाइव', final: 'अंतिम', upcoming: 'अगला मैच', vs: 'बनाम', serving: 'सर्विस', court: 'कोर्ट',
    connecting: 'कनेक्ट हो रहा है', reconnecting: 'फिर से कनेक्ट हो रहा है — पिछला स्कोर', offline: 'ऑफ़लाइन — पिछला स्कोर',
    pairTitle: 'इस स्क्रीन को जोड़ें', pairHelp: 'आयोजक कंसोल में Screens → Pair a screen खोलें और यह कोड दर्ज करें, या QR स्कैन करें।',
    pairExpires: 'कोड अपने आप बदलता है', idle: 'मैच असाइन होने की प्रतीक्षा', standings: 'अंक तालिका', results: 'परिणाम',
    noCourtMatch: 'इस कोर्ट पर कोई मैच नहीं', sponsors: 'हमारे प्रायोजक', played: 'खे', won: 'जी', drawn: 'ड्रॉ', lost: 'हा', pts: 'अंक',
    scanToWatch: 'लाइव देखने के लिए स्कैन करें',
    presentedBy: 'प्रस्तुतकर्ता', sponsoredBy: 'प्रायोजक', poweredBy: 'पावर्ड बाय', timeoutBy: 'टाइमआउट प्रायोजक', matchSponsor: 'आज के मैच के प्रायोजक',
    potm: 'प्लेयर ऑफ़ द मैच', broughtToYouMatch: 'यह मैच आपके लिए लाए हैं', broughtToYou: 'आपके लिए लाए हैं', sponsorsLabel: 'प्रायोजक',
  },
  gu: {
    live: 'લાઇવ', final: 'અંતિમ', upcoming: 'આગળની મેચ', vs: 'વિરુદ્ધ', serving: 'સર્વિસ', court: 'કોર્ટ',
    connecting: 'જોડાઈ રહ્યું છે', reconnecting: 'ફરી જોડાઈ રહ્યું છે — છેલ્લો સ્કોર', offline: 'ઑફલાઇન — છેલ્લો સ્કોર',
    pairTitle: 'આ સ્ક્રીન જોડો', pairHelp: 'આયોજક કન્સોલમાં Screens → Pair a screen ખોલો અને આ કોડ દાખલ કરો, અથવા QR સ્કેન કરો.',
    pairExpires: 'કોડ આપમેળે બદલાય છે', idle: 'મેચ સોંપાય તેની રાહ', standings: 'ગુણ તાલિકા', results: 'પરિણામો',
    noCourtMatch: 'આ કોર્ટ પર કોઈ મેચ નથી', sponsors: 'અમારા પ્રાયોજકો', played: 'રમ્યા', won: 'જીત', drawn: 'ડ્રો', lost: 'હાર', pts: 'ગુણ',
    scanToWatch: 'લાઇવ જોવા સ્કેન કરો',
    presentedBy: 'પ્રસ્તુતકર્તા', sponsoredBy: 'પ્રાયોજક', poweredBy: 'પાવર્ડ બાય', timeoutBy: 'ટાઇમઆઉટ પ્રાયોજક', matchSponsor: 'આજની મેચના પ્રાયોજક',
    potm: 'પ્લેયર ઓફ ધ મેચ', broughtToYouMatch: 'આ મેચ આપના માટે લાવ્યા છે', broughtToYou: 'આપના માટે લાવ્યા છે', sponsorsLabel: 'પ્રાયોજકો',
  },
} as const;

export type Lang = keyof typeof STRINGS;
type Key = keyof (typeof STRINGS)['en'];

let lang: Lang = (() => {
  const q = new URLSearchParams(location.search).get('lang');
  const saved = (() => { try { return localStorage.getItem('arena.lang'); } catch { return null; } })();
  const pick = (q ?? saved ?? navigator.language?.slice(0, 2) ?? 'en') as Lang;
  return pick in STRINGS ? pick : 'en';
})();

export const t = (k: Key): string => (STRINGS[lang] as any)[k] ?? STRINGS.en[k];
export const setLang = (l: Lang) => {
  lang = l;
  try { localStorage.setItem('arena.lang', l); } catch { /* storage unavailable */ }
};
export const getLang = () => lang;
export const LANGS: { id: Lang; label: string }[] = [{ id: 'en', label: 'English' }, { id: 'hi', label: 'हिन्दी' }, { id: 'gu', label: 'ગુજરાતી' }];
