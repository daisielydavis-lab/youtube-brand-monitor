/**
 * Dashboard data types shared between the aggregation layer and the UI.
 * The aggregation itself lives in `app.ts` (queryDashboardData) —
 * all analytics derive from Layer 3 (competitor placements) per data-scope.ts.
 */

export interface DashboardData {
  hasData: boolean;
  scanStatus: {
    lastScanAt: string | null;
    nextScanAt: string;
    totalVideos: number;
    totalCreators: number;
    queriesActive: number;
  };
  kpi: {
    competitorPlacements: number;   // Layer 3: brand ∈ valid AND placement ∈ confirmed/likely
    unresolvedCandidates: number;   // confirmed/likely placement but brand unknown
    activeCreators: number;         // creators behind competitor placements
    activeCampaigns: number;        // filled by the route from campaigns table
    coveragePct: number;            // Layer 2 classified / Layer 1 discovered
    totalVideos: number;            // Layer 1: discovered in window
    totalAnalyzed: number;          // Layer 2: classified in window
    newCompetitorCreators: number;  // first_seen_at within 7d AND competitor placement
  };
  brandComparison: BrandCard[];
  topGames: GameRow[];
  topThemes: ThemeRow[];
  topCreators: CreatorRow[];
  recentVideos: VideoRow[];         // default view: competitor placements
  allRecentVideos?: VideoRow[];     // "All Discovered" toggle
  unresolvedVideos?: VideoRow[];    // "Unresolved Candidates" toggle
  anomalies: string[];
}

export interface BrandCard {
  brandName: string;
  newVideos: number;
  creators: number;
  topGame: string;
  topMarket: string;
  median7dViews: number;
}

export interface GameRow {
  game: string;
  videoCount: number;
  estimatedReach: number;
  brands: Record<string, number>;
}

export interface ThemeRow {
  topic: string;
  videoCount: number;
  brands: Record<string, number>;
}

export interface CreatorRow {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
  subscriberCount: number;
  recentBrand: string;
  recentGame: string;
  format: string;
  views7d: number;
  engagementRate: number;
  sponsorship: string;
  performanceVsBaseline: number | null; // percentage, e.g. +42
}

export interface VideoRow {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  channelName: string;
  brand: string;
  game: string;
  publishedAt: string;
  viewCount: number;
  likeCount?: number;
  commentCount?: number;
  growth24h: number | null;
  growth72h: number | null;
  placementType: string;
  sponsorConfidence: number;
  contentCategory?: string;
  topicCategory?: string;
  reasonCodes?: string[];
  discoveryEvidence: string[];
  promoCode: string | null;
}

