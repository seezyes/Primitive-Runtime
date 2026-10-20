export interface WorkspaceLimits {
  max_file_bytes: number;
  max_workspace_bytes: number;
  max_files: number;
}

export interface ManifestEntry {
  hash: string;
  size: number;
  /** Portable source mode, independent of read-only snapshot permissions. */
  mode: number;
}

export type Manifest = Record<string, ManifestEntry>;

export interface Snapshot {
  root: string;
  source_root: string;
  baseline_root: string;
  baseline_id: string;
  git_head: string;
  manifest: Manifest;
  candidate_hash: string;
  limits: WorkspaceLimits;
}

export interface Candidate {
  root: string;
  hash: string;
  files_changed: string[];
  diff: string;
  manifest: Manifest;
}
