export const SAAVN_BASES = [
  "https://tuneteasers-saavn.sathwik-katepally.workers.dev/api",
  "https://saavn-api.nandanvarma.com/api",
];
/* Every (query, page) pair is one search job. The offline snips scorer runs
   all of them; each game samples a few, so the list is deliberately broad
   (singers, composers, stars, years, moods) to keep games from repeating. */
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
/* Songs JioSaavn reports fewer plays for are mostly dubs and obscure album
   cuts nobody at a party will name. A missing count (0) means unknown, not
   unpopular, and is kept. */
export const SAAVN_MIN_PLAYS = 1_000_000;
export const ITUNES_TERMS = {
  bolly: ["Arijit Singh","Pritam songs","Shreya Ghoshal hindi","A R Rahman hindi","Amit Trivedi","Vishal Shekhar","Sonu Nigam hindi","Atif Aslam hindi","Jubin Nautiyal","Mohit Chauhan","Sachin Jigar","Badshah hindi"],
  telugu: ["Sid Sriram telugu","Devi Sri Prasad hits","Thaman S telugu","Anirudh telugu songs","Mickey J Meyer telugu","Gopi Sundar telugu","M M Keeravani telugu","Armaan Malik telugu","Anurag Kulkarni","telugu hit songs","Kaala Bhairava","Mangli telugu"],
};
export const ITUNES_LANG_OK = { bolly:["bollywood","hindi"], telugu:["telugu","tollywood"] };
export const EXCLUDE_RX = /(remix|mashup|lo-?fi|slowed|reverb|medley|unplugged|acoustic|cover|karaoke|instrumental|\bbgm\b|jukebox|revisited|reprise|redux|\bclub\b|\bdj\b|mix\b|8d\b|sped up|lounge|\bversion\b|\btheme\b|\bost\b|teaser|prevue)/i;

/* A snips.json entry is trusted (mode "snip", raw playback) only when its
   winMax - the window's max p(voice) from the offline MusiCNN VAD - is below
   this. The index ships entries up to 0.40 so this can be tuned client-side
   without a corpus rebuild. Initial value from the 2026-08-31 experiment run
   (~22% of real Saavn songs pass at 0.25); the owner calibrates by ear. */
export const SNIP_CLEAN_MAX = 0.25;

export const ERAS = ["2000s","2010s","2020s"];
export const eraOf = y => y >= 2020 ? "2020s" : y >= 2010 ? "2010s" : "2000s";
