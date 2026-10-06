/**
 * Sponsorship inventory catalog.
 *
 * Every sellable asset type declares which branding SURFACES it activates automatically
 * once an order is active. Assets that can't be automated (wall branding, a social post,
 * a court banner) are DELIVERABLES: the organizer marks them delivered with proof, and the
 * sponsor sees the status. Nothing is silently "auto" that isn't.
 */

export type Surface =
  | 'tv_logo' // small persistent logo on every TV scoreboard in scope
  | 'tv_fullscreen' // "This match is brought to you by" interstitial
  | 'tv_rotation' // a slot in the sponsor rotation on screens and playlists
  | 'tv_match_sponsor' // "Today's match sponsor" before a match starts
  | 'tv_potm' // "Player of the Match presented by"
  | 'tv_timeout' // "Timeout brought to you by"
  | 'tv_break' // "Powered by" at half-time, innings breaks, between sets
  | 'live_page' // sponsor strip on public live-score pages
  | 'tournament_page' // sponsor wall on the public tournament page
  | 'overlay' // broadcast / OBS overlay logo
  | 'title' // naming rights: "<Tournament> presented by <Sponsor>"
  | 'qr' // sponsor QR code on screens and live pages
  | 'web_banner'; // banner on live and tournament pages (also the installed app)

export type ScopeType = 'org' | 'tournament' | 'venue' | 'match';
export type Category = 'tournament' | 'venue' | 'match' | 'digital' | 'broadcast' | 'social';

export interface InventoryType {
  type: string;
  label: string;
  category: Category;
  scopes: ScopeType[];
  surfaces: Surface[];
  deliverable?: boolean; // fulfilled by the organizer, tracked with proof
  assets: ('logo' | 'logo_dark' | 'banner' | 'video' | 'copy' | 'url')[];
  weight?: number; // share of rotation / prominence
}

export const INVENTORY_TYPES: InventoryType[] = [
  // tournament naming & partnership tiers
  { type: 'title_sponsor', label: 'Title Sponsor', category: 'tournament', scopes: ['tournament'], surfaces: ['title', 'tv_logo', 'tv_fullscreen', 'tv_rotation', 'live_page', 'tournament_page', 'overlay', 'web_banner'], assets: ['logo', 'logo_dark', 'banner'], weight: 5 },
  { type: 'powered_by', label: 'Powered By', category: 'tournament', scopes: ['tournament'], surfaces: ['tv_break', 'tv_rotation', 'live_page', 'tournament_page', 'overlay'], assets: ['logo', 'logo_dark'], weight: 4 },
  { type: 'associate_sponsor', label: 'Associate Sponsor', category: 'tournament', scopes: ['tournament'], surfaces: ['tv_rotation', 'tournament_page', 'live_page'], assets: ['logo'], weight: 2 },
  { type: 'official_partner', label: 'Official Partner', category: 'tournament', scopes: ['tournament', 'org'], surfaces: ['tv_rotation', 'tournament_page'], assets: ['logo', 'copy'], weight: 2 },
  { type: 'official_technology_partner', label: 'Official Technology Partner', category: 'tournament', scopes: ['tournament', 'org'], surfaces: ['tv_rotation', 'tournament_page'], assets: ['logo'], weight: 2 },
  { type: 'official_ai_partner', label: 'Official AI Partner', category: 'tournament', scopes: ['tournament', 'org'], surfaces: ['tv_rotation', 'tournament_page'], assets: ['logo'], weight: 2 },
  { type: 'official_sports_partner', label: 'Official Sports Partner', category: 'tournament', scopes: ['tournament', 'org'], surfaces: ['tv_rotation', 'tournament_page'], assets: ['logo'], weight: 2 },
  // venue
  { type: 'venue_sponsor', label: 'Venue Sponsor', category: 'venue', scopes: ['venue'], surfaces: ['tv_logo', 'tv_rotation', 'live_page'], assets: ['logo', 'logo_dark'], weight: 3 },
  { type: 'led_screen', label: 'LED / TV screen slot', category: 'venue', scopes: ['venue', 'tournament'], surfaces: ['tv_rotation', 'tv_fullscreen'], assets: ['logo', 'banner', 'video'], weight: 3 },
  { type: 'digital_banner', label: 'Digital banner', category: 'venue', scopes: ['venue', 'tournament'], surfaces: ['web_banner', 'tv_rotation'], assets: ['banner', 'url'], weight: 2 },
  { type: 'entrance_branding', label: 'Entrance branding', category: 'venue', scopes: ['venue'], surfaces: [], deliverable: true, assets: ['banner'] },
  { type: 'wall_branding', label: 'Wall branding', category: 'venue', scopes: ['venue'], surfaces: [], deliverable: true, assets: ['banner'] },
  { type: 'court_branding', label: 'Court / field branding', category: 'venue', scopes: ['venue'], surfaces: [], deliverable: true, assets: ['logo'] },
  { type: 'table_branding', label: 'Table branding', category: 'venue', scopes: ['venue'], surfaces: [], deliverable: true, assets: ['logo'] },
  // match
  { type: 'match_sponsor', label: 'Match Sponsor', category: 'match', scopes: ['match', 'tournament'], surfaces: ['tv_match_sponsor', 'tv_fullscreen', 'tv_logo', 'live_page'], assets: ['logo', 'logo_dark'], weight: 4 },
  { type: 'match_of_the_day', label: 'Match of the Day', category: 'match', scopes: ['match'], surfaces: ['tv_match_sponsor', 'live_page'], assets: ['logo'], weight: 3 },
  { type: 'player_of_match', label: 'Player of the Match presenter', category: 'match', scopes: ['match', 'tournament'], surfaces: ['tv_potm'], assets: ['logo'], weight: 3 },
  { type: 'timeout_sponsor', label: 'Timeout sponsor', category: 'match', scopes: ['match', 'tournament'], surfaces: ['tv_timeout'], assets: ['logo'], weight: 2 },
  { type: 'break_sponsor', label: 'Break sponsor', category: 'match', scopes: ['match', 'tournament'], surfaces: ['tv_break'], assets: ['logo'], weight: 2 },
  { type: 'ball_sponsor', label: 'Ball sponsor', category: 'match', scopes: ['match', 'tournament'], surfaces: [], deliverable: true, assets: ['logo'] },
  { type: 'presentation_sponsor', label: 'Match presentation sponsor', category: 'match', scopes: ['match', 'tournament'], surfaces: [], deliverable: true, assets: ['logo', 'banner'] },
  // digital
  { type: 'website_banner', label: 'Website banner', category: 'digital', scopes: ['tournament', 'org'], surfaces: ['web_banner'], assets: ['banner', 'url'], weight: 2 },
  { type: 'app_banner', label: 'Mobile app banner', category: 'digital', scopes: ['tournament', 'org'], surfaces: ['web_banner'], assets: ['banner', 'url'], weight: 2 },
  { type: 'live_score_branding', label: 'Live score branding', category: 'digital', scopes: ['tournament', 'match', 'org'], surfaces: ['live_page'], assets: ['logo'], weight: 2 },
  { type: 'tv_scoreboard_logo', label: 'TV scoreboard logo', category: 'digital', scopes: ['tournament', 'venue', 'match', 'org'], surfaces: ['tv_logo', 'live_page', 'tournament_page', 'overlay'], assets: ['logo', 'logo_dark'], weight: 3 },
  { type: 'tv_fullscreen_ad', label: 'TV full-screen advertisement', category: 'digital', scopes: ['tournament', 'venue', 'match'], surfaces: ['tv_fullscreen', 'tv_rotation'], assets: ['logo', 'banner', 'video'], weight: 3 },
  { type: 'qr_ad', label: 'QR code advertisement', category: 'digital', scopes: ['tournament', 'venue', 'match'], surfaces: ['qr', 'tv_rotation'], assets: ['logo', 'url'], weight: 2 },
  { type: 'push_notification', label: 'Push notification', category: 'digital', scopes: ['tournament', 'org'], surfaces: [], deliverable: true, assets: ['copy', 'url'] },
  { type: 'email_promotion', label: 'Email promotion', category: 'digital', scopes: ['tournament', 'org'], surfaces: [], deliverable: true, assets: ['copy', 'banner', 'url'] },
  // broadcast
  { type: 'stream_overlay', label: 'Stream overlay', category: 'broadcast', scopes: ['tournament', 'match'], surfaces: ['overlay'], assets: ['logo_dark'], weight: 3 },
  { type: 'scoreboard_overlay', label: 'Scoreboard overlay', category: 'broadcast', scopes: ['tournament', 'match'], surfaces: ['overlay', 'tv_logo'], assets: ['logo_dark'], weight: 3 },
  { type: 'lower_third', label: 'Lower third', category: 'broadcast', scopes: ['tournament', 'match'], surfaces: ['overlay'], assets: ['logo_dark', 'copy'], weight: 2 },
  { type: 'commercial_break', label: 'Commercial break', category: 'broadcast', scopes: ['tournament', 'match'], surfaces: ['tv_break', 'tv_fullscreen'], assets: ['video', 'banner'], weight: 3 },
  { type: 'sponsor_bumper', label: 'Sponsor bumper', category: 'broadcast', scopes: ['tournament', 'match'], surfaces: ['tv_fullscreen'], assets: ['video', 'logo'], weight: 2 },
  { type: 'pre_match_ad', label: 'Pre-match advertisement', category: 'broadcast', scopes: ['tournament', 'match'], surfaces: ['tv_match_sponsor', 'tv_fullscreen'], assets: ['banner', 'video'], weight: 2 },
  { type: 'post_match_ad', label: 'Post-match advertisement', category: 'broadcast', scopes: ['tournament', 'match'], surfaces: ['tv_potm'], assets: ['banner'], weight: 2 },
  // social (fulfilled by the organizer, proof required)
  { type: 'instagram_post', label: 'Instagram post', category: 'social', scopes: ['tournament', 'org'], surfaces: [], deliverable: true, assets: ['banner', 'copy'] },
  { type: 'instagram_story', label: 'Instagram story', category: 'social', scopes: ['tournament', 'org'], surfaces: [], deliverable: true, assets: ['banner'] },
  { type: 'youtube_branding', label: 'YouTube branding', category: 'social', scopes: ['tournament'], surfaces: [], deliverable: true, assets: ['logo', 'banner'] },
  { type: 'linkedin_post', label: 'LinkedIn post', category: 'social', scopes: ['tournament', 'org'], surfaces: [], deliverable: true, assets: ['banner', 'copy'] },
  { type: 'facebook_post', label: 'Facebook post', category: 'social', scopes: ['tournament', 'org'], surfaces: [], deliverable: true, assets: ['banner', 'copy'] },
  { type: 'x_post', label: 'X post', category: 'social', scopes: ['tournament', 'org'], surfaces: [], deliverable: true, assets: ['banner', 'copy'] },
];

export const inventoryType = (t: string) => INVENTORY_TYPES.find((x) => x.type === t);

/** Exposure flags shown on marketplace cards, derived from what a package actually includes. */
export function exposureOf(types: string[]) {
  const s = new Set(types.flatMap((t) => inventoryType(t)?.surfaces ?? []));
  const cats = new Set(types.map((t) => inventoryType(t)?.category));
  return {
    tv: [...s].some((x) => x.startsWith('tv_')),
    liveScore: s.has('live_page'),
    broadcast: s.has('overlay') || cats.has('broadcast'),
    social: cats.has('social'),
    onsite: types.some((t) => inventoryType(t)?.category === 'venue'),
    online: s.has('live_page') || s.has('web_banner') || s.has('tournament_page'),
  };
}

export const SPONSOR_CATEGORIES = [
  'Corporate Sponsor', 'Brand', 'Startup', 'Local Business', 'SME', 'Individual Sponsor', 'Influencer / Creator', 'Sports Brand',
  'Restaurant / Hotel', 'Education Institution', 'Healthcare Organization', 'Government / PSU', 'NGO', 'Event Partner', 'Media Partner',
  'Technology Partner', 'Community Sponsor',
];

export const INDUSTRIES = [
  'fitness', 'sportswear', 'food-beverage', 'education', 'healthcare', 'finance', 'insurance', 'real-estate', 'automotive', 'telecom',
  'technology', 'retail', 'hospitality', 'media', 'fmcg', 'energy', 'government', 'non-profit', 'other',
];

/** Which audiences an industry usually wants — used by the recommendation engine. */
export const INDUSTRY_AFFINITY: Record<string, { sports: string[]; levels: string[] }> = {
  fitness: { sports: ['football', 'basketball', 'badminton', 'pickleball', 'padel', 'volleyball'], levels: ['local', 'state'] },
  sportswear: { sports: ['football', 'cricket', 'tennis', 'badminton', 'basketball'], levels: ['state', 'national'] },
  'food-beverage': { sports: ['cricket', 'football', 'volleyball'], levels: ['local', 'state'] },
  education: { sports: ['cricket', 'football', 'badminton', 'table-tennis', 'basketball'], levels: ['school', 'college', 'local'] },
  healthcare: { sports: ['badminton', 'pickleball', 'tennis', 'table-tennis'], levels: ['local', 'corporate'] },
  finance: { sports: ['cricket', 'tennis', 'padel', 'snooker'], levels: ['corporate', 'state', 'national'] },
  technology: { sports: ['cricket', 'football', 'padel', 'pickleball'], levels: ['corporate', 'college'] },
  hospitality: { sports: ['padel', 'tennis', 'snooker', 'billiards'], levels: ['local', 'corporate'] },
};

export const SALE_MODELS = ['fixed', 'fcfs', 'rfp', 'negotiated', 'auction'] as const;
export const LEVELS = ['school', 'college', 'corporate', 'local', 'state', 'national', 'international'] as const;
