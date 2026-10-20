export interface ValidationCheck {
  id: string;
  command: string;
  args: string[];
  required: boolean;
  timeout_seconds: number;
}

export interface ValidationProfile {
  id?: string;
  revision: string;
  backend: "bwrap" | "docker";
  checks: ValidationCheck[];
  limits: {
    memory_mb: number;
    cpu_seconds: number;
    pids: number;
    max_output_bytes: number;
    max_disk_mb: number;
  };
  network: "none";
  /** Docker Linux image pinned to an immutable digest; it must already be installed. */
  image?: string;
  /** Additional operator-owned, read-only tool directories outside the standard system paths. */
  tools?: string[];
}

export interface CheckResult {
  check_id: string;
  status: "passed" | "failed" | "unavailable";
  required: boolean;
  exit_code: number | null;
  output: string;
  timed_out: boolean;
  candidate_hash: string;
  output_truncated?: boolean;
}

export interface ValidationReport {
  checks: CheckResult[];
  verification: "passed" | "failed" | "unverified";
  infrastructure_error?: { code: string; message: string };
  sandbox?: {
    backend: string;
    proc: boolean;
    memory_limit_scope: "container" | "process-address-space";
    cpu_limit_scope: "container-wall-cap" | "process";
    network: "none";
  };
}

export interface SandboxProbe {
  available: boolean;
  backend: string;
  reason?: string;
  proc?: boolean;
}

export interface ValidationOptions {
  /** Durable service-owned directory, outside the candidate, for container receipts. */
  lease_dir: string;
}
