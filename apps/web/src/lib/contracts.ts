/**
 * Zod mirror of services/api/smartcity_api/contracts.py (owner: coordinator).
 * Every API response is validated at runtime; an invalid response becomes an
 * error state in the UI instead of a crash or partially rendered garbage.
 *
 * Requests are `.strict()` (the server forbids extra fields). Responses strip
 * unknown keys so an additive server change does not take the UI down, but every
 * field the UI relies on is required with the exact type from the contract.
 */
import { z } from "zod";

export const CATEGORIES = ["cafe", "food", "park", "culture", "attraction", "playground", "mall"] as const;
export const FEATURES = ["socket", "wifi", "outdoor_seating", "wheelchair", "indoor", "kids"] as const;
export const INTERESTS = [
  "coffee",
  "food",
  "nature",
  "culture",
  "architecture",
  "kids",
  "quiet",
  "indoor",
  "shopping",
] as const;

export const CategorySchema = z.enum(CATEGORIES);
export const FeatureSchema = z.enum(FEATURES);
export const InterestSchema = z.enum(INTERESTS);
export const OpeningStatusSchema = z.enum(["open", "closed", "unknown"]);
export const DistanceMethodSchema = z.enum(["pedestrian_route", "geodesic"]);
export const ResponseStatusSchema = z.enum(["ok", "no_match", "needs_clarification", "degraded"]);
export const ResponseModeSchema = z.enum(["live_rag", "retrieval_only"]);
export const ConstraintSourceSchema = z.enum(["ui", "text"]);

export type Category = z.infer<typeof CategorySchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type Interest = z.infer<typeof InterestSchema>;
export type OpeningStatus = z.infer<typeof OpeningStatusSchema>;

const finite = z.number().finite();
const isoDateTime = z.string().datetime({ offset: true });
const int = z.number().int();

export const LatLonSchema = z
  .object({
    lat: finite.min(-90).max(90),
    lon: finite.min(-180).max(180),
  })
  .strict();
export type LatLon = z.infer<typeof LatLonSchema>;

// ------------------------------------------------------------- recommend: request

export const DroppedCodeSchema = z
  .string()
  .regex(
    /^(must_be_open|max_distance|(include_category|exclude_category):(cafe|food|park|culture|attraction|playground|mall)|required_feature:(socket|wifi|outdoor_seating|wheelchair|indoor|kids))$/,
  );

export const ConstraintsSchema = z
  .object({
    required_features: z.array(FeatureSchema).max(6).default([]),
    preferred_features: z.array(FeatureSchema).max(6).default([]),
    include_categories: z.array(CategorySchema).max(7).default([]),
    exclude_categories: z.array(CategorySchema).max(7).default([]),
    must_be_open: z.boolean().default(false),
    max_distance_m: int.min(100).max(10000).nullable().default(null),
    exclude_place_ids: z.array(z.string()).max(20).default([]),
    // Text-derived hard conditions the user dropped via a relaxation (server re-sends them in patches).
    dropped_text_constraints: z.array(DroppedCodeSchema).max(20).default([]),
  })
  .strict();
export type Constraints = z.infer<typeof ConstraintsSchema>;

export const ConversationTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(500),
  })
  .strict();
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

export const ClientRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const RecommendRequestSchema = z
  .object({
    origin: LatLonSchema,
    query: z.string().max(2000).default(""),
    time_budget_min: int.min(10).max(180),
    return_to_start: z.boolean().default(true),
    travel_mode: z.literal("walking").default("walking"),
    interests: z.array(InterestSchema).max(9).default([]),
    constraints: ConstraintsSchema,
    conversation_context: z.array(ConversationTurnSchema).max(6).default([]),
    start_time: isoDateTime.nullable().default(null),
    client_request_id: ClientRequestIdSchema,
  })
  .strict();
export type RecommendRequest = z.infer<typeof RecommendRequestSchema>;

// ------------------------------------------------------------- recommend: response

export const AppliedConstraintSchema = z.object({
  kind: z.enum([
    "time_budget",
    "return_to_start",
    "walking_only",
    "required_feature",
    "include_category",
    "exclude_category",
    "must_be_open",
    "max_distance",
  ]),
  value: z.union([z.string(), z.number(), z.boolean()]),
  source: ConstraintSourceSchema,
  label: z.string(),
});
export type AppliedConstraint = z.infer<typeof AppliedConstraintSchema>;

export const ConstraintsAppliedSchema = z.object({
  hard: z.array(AppliedConstraintSchema),
  preferences: z.array(z.string()),
  interpreted_query: z.string().nullable().optional().default(null),
});

export const DistanceSchema = z.object({
  meters: int.min(0),
  method: DistanceMethodSchema,
  note: z.string(),
});

export const TimingSchema = z.object({
  outbound_min: int.min(0),
  visit_min: int.min(0),
  return_min: int.min(0).nullable(),
  buffer_min: int.min(0),
  total_min: int.min(0),
  estimated: z.literal(true),
  method: z.string(),
});
export type Timing = z.infer<typeof TimingSchema>;

export const FeatureFactSchema = z.object({
  feature: FeatureSchema,
  value: z.boolean(),
  basis: z.enum(["tag", "category_rule"]),
  evidence: z.string(),
});
export type FeatureFact = z.infer<typeof FeatureFactSchema>;

export const EvidenceItemSchema = z.object({
  field: z.string(),
  source_value: z.string(),
  source_url: z.string(),
  license: z.string(),
  collected_at: isoDateTime,
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const SourceRefSchema = z.object({
  name: z.literal("OpenStreetMap"),
  osm_type: z.enum(["node", "way", "relation"]),
  osm_id: int,
  url: z.string(),
  license: z.string(),
  fetched_at: isoDateTime,
  source_updated_at: isoDateTime.nullable().optional().default(null),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const RecommendationSchema = z.object({
  place_id: z.string().min(1),
  name: z.string().min(1),
  name_is_generic: z.boolean(),
  category: CategorySchema,
  category_label: z.string(),
  coordinates: LatLonSchema,
  address: z.string().nullable(),
  reason: z.string().nullable(),
  reason_source: z.enum(["llm", "rules"]),
  activity_suggestion: z.string().nullable(),
  distance: DistanceSchema,
  timing: TimingSchema,
  opening_status: OpeningStatusSchema,
  opening_hours_raw: z.string().nullable(),
  opening_note: z.string(),
  as_of: isoDateTime,
  verified_features: z.array(FeatureFactSchema),
  unknown_features: z.array(FeatureSchema),
  negative_features: z.array(FeatureFactSchema),
  website: z.string().nullable(),
  source: SourceRefSchema,
  evidence: z.array(EvidenceItemSchema),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const WarningSchema = z.object({ code: z.string(), message: z.string() });
export type ApiWarning = z.infer<typeof WarningSchema>;

/** Relaxation patches come from the server and are resent as-is, so they are parsed strictly. */
export const RelaxationSchema = z.object({
  code: z.string(),
  message: z.string(),
  patch: ConstraintsSchema,
});
export type Relaxation = z.infer<typeof RelaxationSchema>;

export const ProviderInfoSchema = z.object({
  llm_provider: z.string().nullable(),
  llm_model: z.string().nullable(),
  embedding_provider: z.string().nullable(),
  embedding_model: z.string().nullable(),
  embedding_dim: int.nullable(),
  routing: z.enum(["none", "valhalla"]),
});

export const RecommendResponseSchema = z
  .object({
    request_id: z.string(),
    client_request_id: z.string(),
    status: ResponseStatusSchema,
    mode: ResponseModeSchema,
    dataset_version: z.string(),
    constraints_applied: ConstraintsAppliedSchema,
    recommendations: z.array(RecommendationSchema).max(3),
    message: z.string(),
    warnings: z.array(WarningSchema),
    suggested_relaxations: z.array(RelaxationSchema),
    route: z.null().optional().default(null),
    providers: ProviderInfoSchema,
    timings_ms: z.record(z.string(), int),
  })
  .superRefine((value, ctx) => {
    const ids = value.recommendations.map((r) => r.place_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate place_id in recommendations" });
    }
  });
export type RecommendResponse = z.infer<typeof RecommendResponseSchema>;

// ------------------------------------------------------------- other endpoints

export const ComponentStatusSchema = z.object({
  status: z.enum(["ok", "degraded", "unavailable", "not_configured"]),
  detail: z.string(),
});
export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

export const ReadyResponseSchema = z.object({
  ready: z.boolean(),
  components: z.record(z.string(), ComponentStatusSchema),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

export const PlaceSummarySchema = z.object({
  place_id: z.string().min(1),
  name: z.string().min(1),
  name_is_generic: z.boolean(),
  category: CategorySchema,
  category_label: z.string(),
  coordinates: LatLonSchema,
  address: z.string().nullable(),
});
export type PlaceSummary = z.infer<typeof PlaceSummarySchema>;

export const PlaceDetailSchema = PlaceSummarySchema.extend({
  description: z.string(),
  opening_hours_raw: z.string().nullable(),
  website: z.string().nullable(),
  verified_features: z.array(FeatureFactSchema),
  unknown_features: z.array(FeatureSchema),
  negative_features: z.array(FeatureFactSchema),
  source: SourceRefSchema,
  evidence: z.array(EvidenceItemSchema),
});
export type PlaceDetail = z.infer<typeof PlaceDetailSchema>;

export const PlacesResponseSchema = z.object({
  dataset_version: z.string(),
  items: z.array(PlaceSummarySchema),
  truncated: z.boolean(),
});

export const SearchResponseSchema = z.object({
  query: z.string(),
  items: z.array(PlaceSummarySchema),
  method: z.string(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const CoverageResponseSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.record(z.string(), z.unknown())),
  dataset_version: z.string(),
  place_count: int.min(0),
  freshness: isoDateTime.nullable(),
  updated_at: isoDateTime.nullable(),
  bbox: z.array(finite).length(4),
  default_origin: LatLonSchema,
  default_origin_label: z.string(),
});
export type CoverageResponse = z.infer<typeof CoverageResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  request_id: z.string().nullable().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const EMPTY_CONSTRAINTS: Constraints = {
  required_features: [],
  preferred_features: [],
  include_categories: [],
  exclude_categories: [],
  must_be_open: false,
  max_distance_m: null,
  exclude_place_ids: [],
  dropped_text_constraints: [],
};

// ------------------------------------------------------------- recommend stream (NDJSON)

/** One line of POST /api/recommend/stream: optional "preliminary" (places found by retrieval
 * before generation finishes), then "final" (same as /api/recommend) or "error". */
export const RecommendStreamEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("preliminary"), response: RecommendResponseSchema, error: z.null().optional() }),
  z.object({ event: z.literal("final"), response: RecommendResponseSchema, error: z.null().optional() }),
  z.object({ event: z.literal("error"), response: z.null().optional(), error: ErrorResponseSchema }),
]);
export type RecommendStreamEvent = z.infer<typeof RecommendStreamEventSchema>;

// ------------------------------------------------------------- base map (GET /api/basemap)

const Count = z.number().int().nonnegative();
const Str = z.string().nullable().optional();
export const SatelliteConfigSchema = z.discriminatedUnion("enabled", [
  z.object({
    enabled: z.literal(true),
    // Only the EOX tile host is accepted (also pinned by the CSP).
    tiles: z.array(z.string().regex(/^https:\/\/tiles\.maps\.eox\.at\//)).min(1).max(4),
    maxzoom: z.number().int().min(0).max(22),
    attribution: z.string().max(1000),
    license: z.string(),
    license_url: Str,
    resolution_m: z.number().positive().nullable().optional(),
  }),
  z.object({ enabled: z.literal(false), reason: Str }),
]);
export const BasemapInfoSchema = z.object({
  bbox: z.array(z.number()).length(4).nullable().optional(),
  built_at: Str,
  attribution: Str,
  licenses: z.record(z.object({ license: Str, attribution: Str, url: Str }).passthrough()).optional(),
  coverage: z
    .object({
      admin_boundary: Str,
      boundary_area_km2: z.number().nullable().optional(),
      boundary_inside_tiles: z.boolean().nullable().optional(),
    })
    .passthrough()
    .optional(),
  base_source: Str,
  buildings_source: Str,
  level_height_m: z.number().positive().nullable().optional(),
  default_height_m: z.number().positive().nullable().optional(),
  height_source: z
    .object({ height: Count.default(0), levels: Count.default(0), estimate: Count.default(0), default: Count.default(0) })
    .default({}),
  tiles_version: z.string().regex(/^[0-9a-f]{1,32}$/).nullable().optional(),
  estimate_rules: z.record(z.record(z.number())).optional(),
  roofs: z.record(Count).optional(),
  stylised_landmarks: z.array(z.object({ osm: z.string() }).passthrough()).optional(),
  buildings: Count.nullable().optional(),
  usage_mode: z.enum(["noncommercial", "commercial"]).optional(),
  satellite: SatelliteConfigSchema.optional(),
});
export type BasemapInfo = z.infer<typeof BasemapInfoSchema>;
export type SatelliteConfig = z.infer<typeof SatelliteConfigSchema>;
