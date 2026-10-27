/**
 * Where the people should be based. `code` is the ISO 3166-1 alpha-2 country code Hunter
 * expects; `apollo` is the place name Apollo's `person_locations[]` filter matches.
 */
export const LOCATIONS = [
  { code: "", label: "Anywhere" },
  { code: "IN", label: "India", apollo: "india" },
  { code: "US", label: "United States", apollo: "united states" },
  { code: "GB", label: "United Kingdom", apollo: "united kingdom" },
  { code: "CA", label: "Canada", apollo: "canada" },
  { code: "SG", label: "Singapore", apollo: "singapore" },
  { code: "AE", label: "United Arab Emirates", apollo: "united arab emirates" },
  { code: "DE", label: "Germany", apollo: "germany" },
  { code: "NL", label: "Netherlands", apollo: "netherlands" },
  { code: "IE", label: "Ireland", apollo: "ireland" },
  { code: "AU", label: "Australia", apollo: "australia" },
];

export const DEFAULT_LOCATION = "IN";

export function findLocation(code) {
  return LOCATIONS.find((l) => l.code === (code || "")) || LOCATIONS[0];
}

export function locationLabel(code) {
  return code ? findLocation(code).label : "";
}
