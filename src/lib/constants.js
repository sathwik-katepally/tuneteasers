/* The project's own Worker: the first Saavn base and the group sync API. */
export const WORKER_API = "https://tuneteasers-saavn.sathwik-katepally.workers.dev/api";
export const SAAVN_BASES = [
  WORKER_API,
  "https://saavn-api.nandanvarma.com/api",
];
/* Every (query, page) pair is one search job for the client's tier-2 fallback
   search, used when corpus ids cannot be resolved (docs/song-loading.md).
   Each game samples a few, so the list is deliberately broad (singers,
   composers, stars, years, moods) to keep games from repeating. */
export const SAAVN_QUERIES = {
  bolly: [
    "bollywood hits","hindi hit songs","best of bollywood","bollywood 2000s hits","hindi songs 2010s","hindi songs 2020s",
    "hindi songs 2005","hindi songs 2008","hindi songs 2012","hindi songs 2015","hindi songs 2018","hindi songs 2023",
    "hindi romantic hits","hindi dance hits","hindi party songs","hindi wedding songs","hindi sad songs",
    "Arijit Singh hits","Shreya Ghoshal hindi","Sonu Nigam hits","KK hits","Shaan hits","Sunidhi Chauhan hits","Neha Kakkar hits",
    "Jubin Nautiyal hits","Mohit Chauhan hits","Vishal Mishra hits","Darshan Raval hits","Udit Narayan 2000s hits","Sukhwinder Singh hits",
    "Rahat Fateh Ali Khan hindi","Javed Ali hits","B Praak hits","Badshah hits","Yo Yo Honey Singh hits","Mika Singh hits",
    "Himesh Reshammiya hits","Sachet Tandon hits","Armaan Malik hindi","Benny Dayal hindi",
    "Pritam hits","A R Rahman hindi","Vishal Shekhar hits","Shankar Ehsaan Loy hits","Amit Trivedi hits","Sachin Jigar hits",
    "Tanishk Bagchi hits","Mithoon hits","Salim Sulaiman hits","Sajid Wajid hits","Anirudh hindi",
    "Shah Rukh Khan songs","Salman Khan songs","Aamir Khan songs","Ranbir Kapoor songs","Hrithik Roshan songs","Ranveer Singh songs",
    "Akshay Kumar songs","Varun Dhawan songs","Kartik Aaryan songs","Deepika Padukone songs",
  ],
  telugu: [
    "telugu hits","telugu hit songs","top telugu songs","tollywood hits","telugu 2000s hits","telugu songs 2010s","telugu songs 2020s",
    "telugu songs 2005","telugu songs 2008","telugu songs 2012","telugu songs 2015","telugu songs 2018","telugu songs 2023",
    "telugu melody hits","telugu mass hits","telugu love songs","telugu wedding songs","telugu sad songs",
    "Sid Sriram telugu","Karthik telugu hits","Shreya Ghoshal telugu","Chinmayi telugu","Anurag Kulkarni hits","Rahul Sipligunj hits",
    "Mangli songs","Hemachandra hits","Armaan Malik telugu","Kaala Bhairava hits","Sunitha telugu hits","Geetha Madhuri hits",
    "Haricharan telugu","Ram Miriyala hits","Javed Ali telugu","Shankar Mahadevan telugu",
    "Devi Sri Prasad hits","Thaman hits","Anirudh telugu","M M Keeravani hits","Mickey J Meyer hits","Anup Rubens hits",
    "Gopi Sundar telugu","A R Rahman telugu","Harris Jayaraj telugu","Mani Sharma hits","R P Patnaik hits","Chakri hits",
    "Vivek Sagar hits","Hesham Abdul Wahab telugu","Bheems Ceciroleo hits","Yuvan Shankar Raja telugu",
    "Mahesh Babu songs","Allu Arjun songs","Jr NTR songs","Prabhas songs","Ram Charan songs","Pawan Kalyan songs",
    "Nani songs","Vijay Deverakonda songs","Chiranjeevi songs","Ravi Teja songs",
  ],
};
export const SAAVN_PAGES = 2;
/* The curated corpus (public/corpus.json, docs/song-loading.md). A game draws
   CORPUS_DRAW candidates and resolves them to stream URLs in batches of
   CORPUS_BATCH ids per request (the worker caps a batch at 50). */
export const CORPUS_DRAW = 60;
export const CORPUS_BATCH = 30;
export const DIFFICULTIES = ["easy", "medium", "hard", "mixed"];
/* Which corpus tiers each difficulty setting draws from. A setting whose
   tiers hold too few songs for the chosen languages and eras widens to all
   tiers before the crate reports "thin". */
export const DIFFICULTY_TIERS = {
  easy: ["easy"],
  medium: ["easy", "medium"],
  hard: ["medium", "hard"],
  mixed: ["easy", "medium", "hard"],
};
/* Songs JioSaavn reports fewer plays for are mostly dubs and obscure album
   cuts nobody at a party will name. A missing count (0) means unknown, not
   unpopular, and is kept. */
export const SAAVN_MIN_PLAYS = 1_000_000;
export const EXCLUDE_RX = /(remix|mashup|lo-?fi|slowed|reverb|medley|unplugged|acoustic|cover|karaoke|instrumental|\bbgm\b|jukebox|revisited|reprise|redux|\bclub\b|\bdj\b|mix\b|8d\b|sped up|lounge|\bversion\b|\btheme\b|\bost\b|teaser|prevue)/i;

/* The snips.json contract shared by the offline scorer and the client: every
   Music-only interval is exactly SNIP_WINDOW_SEC long, which must hold the
   whole Music-only clip ladder (CLIP_LADDER in src/lib/config.ts), and was
   judged vocal-free by the detector its schema version names. Two versions
   may authorize: MusiCNN's v4 index (every patch below 0.25 voice
   probability) serves until the vocal-stem curves cover the corpus, and then
   the scorer publishes v5 by itself (separated vocal stems below
   SNIP_VOCAL_MAX_DB dBFS). Each entry must carry its version's method and
   pass its version's check, and a saved snip must carry an accepted method.
   Changing the window length or a detector means a new version and method,
   so an index or a saved game from before can never authorize playback. */
export const SNIP_INDEX_V = 5;
export const SNIP_METHOD = "vocal-stem-v5";
export const SNIP_WINDOW_SEC = 12;
export const SNIP_VOCAL_MAX_DB = -50;
export const SNIP_LEGACY = { v: 4, method: "continuous-v4", maxVoice: 0.25 };
export const SNIP_ACCEPTED = {
  [SNIP_INDEX_V]: { method: SNIP_METHOD, clean: e => Number.isFinite(e.vocalDb) && e.vocalDb < SNIP_VOCAL_MAX_DB },
  [SNIP_LEGACY.v]: { method: SNIP_LEGACY.method, clean: e => Number.isFinite(e.maxVoice) && e.maxVoice < SNIP_LEGACY.maxVoice },
};
export const snipMethodOk = m => Object.values(SNIP_ACCEPTED).some(a => a.method === m);
export const SNIP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const ERAS = ["2000s","2010s","2020s"];
export const eraOf = y => y >= 2020 ? "2020s" : y >= 2010 ? "2010s" : "2000s";

/* What a phone may bring to a buzz-in room of its own song history
   (docs/room-mode.md): at most `songs` song keys of up to `key` characters,
   each with the hours until it may come back. The room enforces these; the
   phone sends the ones sitting out longest when it has more. */
export const ROOM_HEARD = { songs: 300, key: 80, hours: 24 * 366 };
