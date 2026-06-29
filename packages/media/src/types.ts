export enum MediaKind {
  Image = 'image',
  Video = 'video',
  Audio = 'audio',
  Pdf = 'pdf',
  Model3d = '3d',
  Other = 'other',
}

export enum DerivativeType {
  Thumbnail = 'thumbnail',
  Poster = 'poster',
  Sprite = 'sprite',
  Variant = 'variant',
}

export interface MediaAsset {
  object_id: string;
  kind: MediaKind;
  width?: number;
  height?: number;
  duration_ms?: number;
  codec?: string;
  frame_rate?: number;
  has_audio?: boolean;
  probe_json?: Record<string, unknown>;
}

export interface Set {
  org_id: string;
  name: string;
  base_object_id: string;
}

export interface SetItem {
  set_id: string;
  object_id: string;
  aspect_ratio: string;
  width: number;
  height: number;
  role: string;
}

export interface Storyboard {
  org_id: string;
  name: string;
}

export interface StoryboardClip {
  storyboard_id: string;
  object_id: string;
  position: number;
  note: string;
}

export interface Derivative {
  object_id: string;
  type: DerivativeType;
  minio_key: string;
  width: number;
  height: number;
  bytes: number;
  billable: boolean;
}

export interface Tag {
  org_id: string;
  name: string;
  slug: string;
}

export interface Category {
  org_id: string;
  name: string;
  slug: string;
  parent_id?: string;
}
