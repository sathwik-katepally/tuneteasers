export const SAAVN_BASES = [
  "https://saavn-api.nandanvarma.com/api",
  "https://saavn.dev/api",
];
export const SAAVN_QUERIES = {
  bolly: ["bollywood hits","hindi hit songs","Arijit Singh hits","Pritam hits","best of bollywood","hindi songs 2010s","hindi songs 2020s","Shreya Ghoshal hindi","A R Rahman hindi","hindi romantic hits","hindi dance hits","Atif Aslam hits"],
  telugu: ["telugu hits","telugu hit songs","top telugu songs","Sid Sriram telugu","Devi Sri Prasad hits","telugu songs 2010s","telugu songs 2020s","Thaman hits","Anirudh telugu","telugu melody hits","telugu mass hits","tollywood hits"],
};
export const ITUNES_TERMS = {
  bolly: ["Arijit Singh","Pritam songs","Shreya Ghoshal hindi","A R Rahman hindi","Amit Trivedi","Vishal Shekhar","Sonu Nigam hindi","Atif Aslam hindi","Jubin Nautiyal","Mohit Chauhan","Sachin Jigar","Badshah hindi"],
  telugu: ["Sid Sriram telugu","Devi Sri Prasad hits","Thaman S telugu","Anirudh telugu songs","Mickey J Meyer telugu","Gopi Sundar telugu","M M Keeravani telugu","Armaan Malik telugu","Anurag Kulkarni","telugu hit songs","Kaala Bhairava","Mangli telugu"],
};
export const ITUNES_LANG_OK = { bolly:["bollywood","hindi"], telugu:["telugu","tollywood"] };
export const EXCLUDE_RX = /(remix|mashup|lo-?fi|slowed|reverb|medley|unplugged|acoustic|cover|karaoke|instrumental|\bbgm\b|jukebox|revisited|reprise|redux|\bclub\b|\bdj\b|mix\b|8d\b|sped up|lounge|female version|male version)/i;

export const ERAS = ["2000s","2010s","2020s"];
export const eraOf = y => y >= 2020 ? "2020s" : y >= 2010 ? "2010s" : "2000s";
