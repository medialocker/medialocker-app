export type MembershipRole = "owner" | "admin" | "member";
export type MediaKind = "image" | "video" | "audio" | "pdf" | "3d" | "other";
export type DerivativeType = "thumbnail" | "poster" | "sprite" | "variant";
export type UsageEventType = "stored_delta" | "egress" | "request";
export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "unpaid"
  | "paused";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface Membership {
  id: string;
  org_id: string;
  user_id: string;
  role: MembershipRole;
  created_at: string;
}

export interface Plan {
  id: string;
  tier_key: string;
  name: string;
  included_gb: number;
  per_gb_price_cents: number;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  stripe_addon_price_id: string | null;
  created_at: string;
}

export interface Subscription {
  id: string;
  org_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string | null;
  plan_id: string;
  status: SubscriptionStatus;
  current_period_end: string;
  created_at: string;
}

export interface Capacity {
  id: string;
  org_id: string;
  allocated_bytes: bigint;
  used_bytes: bigint;
  auto_enabled: boolean;
  increment_gb: number;
  threshold_pct: number;
  max_monthly_spend_cents: number | null;
  spend_this_cycle_cents: number;
  last_auto_add_at: string | null;
}

export interface BillingAddon {
  id: string;
  org_id: string;
  stripe_item_id: string;
  gb: number;
  cost_cents: number;
  prorated: boolean;
  created_at: string;
}

export interface WebhookEvent {
  event_id: string;
  event_type: string;
  processed_at: string;
}

export interface Bucket {
  id: string;
  org_id: string;
  name: string;
  minio_bucket: string;
  versioning_enabled: boolean;
  created_at: string;
  deleted_at: string | null;
}

export interface StorageObject {
  id: string;
  bucket_id: string;
  key: string;
  version_id: string | null;
  size: bigint;
  etag: string | null;
  content_type: string | null;
  storage_class: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ObjectUserMetadata {
  id: string;
  object_id: string;
  key: string;
  value: string;
}

export interface MultipartUpload {
  upload_id: string;
  bucket_id: string | null;
  key: string;
  total_bytes_reserved: bigint;
  content_type: string | null;
  created_at: string;
}

export interface MultipartPart {
  upload_id: string;
  part_number: number;
  etag: string;
  size: bigint;
}

export interface ApiKey {
  id: string;
  org_id: string;
  name: string | null;
  access_key_id: string;
  secret_enc: string;
  bearer_lookup_hash: string;
  scopes: string[];
  bucket_scope: string | null;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ServiceSecret {
  id: string;
  name: string;
  version_id: string;
  /** AES-256-GCM ciphertext (encrypted with API_KEY_ENC_KEY) — never plaintext. */
  value_enc: string;
  stages: string[];
  created_at: string;
}

export interface MediaAsset {
  id: string;
  object_id: string;
  kind: MediaKind;
  width: number | null;
  height: number | null;
  duration_ms: bigint | null;
  codec: string | null;
  frame_rate: number | null;
  has_audio: boolean | null;
  probe_json: Record<string, unknown> | null;
}

export interface Tag {
  id: string;
  org_id: string;
  name: string;
  slug: string;
}

export interface ObjectTag {
  id: string;
  object_id: string;
  tag_id: string;
}

export interface Category {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  parent_id: string | null;
}

export interface ObjectCategory {
  id: string;
  object_id: string;
  category_id: string;
}

export interface Set {
  id: string;
  org_id: string;
  name: string;
  base_object_id: string | null;
  created_at: string;
}

export interface SetItem {
  id: string;
  set_id: string;
  object_id: string;
  aspect_ratio: string | null;
  width: number | null;
  height: number | null;
  role: string | null;
}

export interface Storyboard {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
}

export interface StoryboardClip {
  id: string;
  storyboard_id: string;
  object_id: string;
  position: number;
  note: string | null;
}

export interface Derivative {
  id: string;
  object_id: string;
  type: DerivativeType;
  minio_key: string;
  width: number | null;
  height: number | null;
  bytes: bigint;
  billable: boolean;
}

export interface SearchIndex {
  id: string;
  object_id: string;
  tsv: string | null;
}

export interface UsageEvent {
  id: number;
  org_id: string;
  type: UsageEventType;
  bytes: bigint;
  ts: string;
}

export interface UsageRollup {
  id: string;
  org_id: string;
  period: string;
  stored_bytes_max: bigint;
  egress_bytes: bigint;
  request_count: bigint;
}

export interface AuditLogEntry {
  id: number;
  org_id: string;
  actor: string;
  action: string;
  target: string;
  ip: string | null;
  ts: string;
}
