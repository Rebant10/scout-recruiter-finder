/**
 * Who to look for at a company. Each mode maps to the filters each data
 * provider understands: Hunter takes `job_titles` / `department`, Apollo takes
 * a list of `person_titles[]` (it also matches similar titles).
 */
export const MODES = {
  recruiters: {
    label: "Recruiters",
    hunter: {
      job_titles: "recruiter,recruiting,talent acquisition,talent partner,sourcer,head of talent",
    },
    apollo: [
      "recruiter",
      "technical recruiter",
      "talent acquisition",
      "talent acquisition partner",
      "talent partner",
      "sourcer",
      "recruiting manager",
      "head of talent",
      "campus recruiter",
      "university recruiter",
    ],
  },
  hr: {
    label: "HR & People",
    hunter: { department: "hr" },
    apollo: [
      "human resources",
      "hr manager",
      "hr business partner",
      "people partner",
      "people operations",
      "head of people",
      "talent acquisition",
      "recruiter",
    ],
  },
  all: {
    label: "Everyone",
    hunter: {},
    apollo: [],
  },
};

export const DEFAULT_MODE = "recruiters";

const RECRUITER = /\b(recruit\w*|talent acquisition|sourc(?:er|ers|ing)|talent partner|headhunt\w*|staffing)\b/i;
const TALENT = /\b(talent|hiring|campus|university relations|people partner|hrbp|hr business partner)\b/i;
const HR = /\b(hr|human resources?|people (?:ops|operations|team|lead|manager|director)|head of people|chief people|people (?:&|and) culture)\b/i;

export function roleScore(title = "") {
  if (!title) return 0;
  if (RECRUITER.test(title)) return 3;
  if (TALENT.test(title)) return 2;
  if (HR.test(title)) return 1;
  return 0;
}

export function roleTag(title = "") {
  return ["", "HR", "Talent", "Recruiter"][roleScore(title)];
}
