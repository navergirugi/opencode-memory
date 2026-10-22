/** Shared types for the OpenCode memory plugin. */

export const SCHEMA_VERSION = 1
export const ANALYZER_VERSION = "1.0.0"

export type RecordSource = "api" | "prompt-hook" | "event" | "tool-hook"

export type RecordKind =
  | "session.meta"
  | "message.user"
  | "message.assistant.text"
  | "message.assistant.reasoning"
  | "message.assistant.tool"
  | "message.shell"
  | "message.synthetic"
  | "message.system"
  | "message.skill"
  | "message.compaction"

export interface MemoryRecord {
  schema_version: number
  record_id: string
  kind: RecordKind
  project_id: string
  developer_id: string
  device_id: string
  session_id: string
  message_id?: string
  event: string
  created_at: string
  collected_at: string
  source: RecordSource
  payload: Record<string, unknown>
}

export interface MemoryConfig {
  schema_version: number
  repo_url: string
  developer_id: string
  developer_name?: string
  device_id: string
  device_name?: string
  /** Map of OpenCode project ID -> memory project ID. Unmapped projects use their OpenCode ID. */
  project_ids: Record<string, string>
  data_dir?: string
  sync_interval_seconds: number
  scan_interval_seconds: number
  analysis_interval_hours: number
  context_max_chars: number
  setup_completed_at?: string
  paused?: boolean
  collect_all_projects?: boolean
}

export interface SetupInput {
  repoURL: string
  developerID: string
  developerName?: string
  deviceName?: string
  projectID?: string
  opencodeProjectID?: string
  dataDir?: string
}

export interface Cursor {
  last_collected_at: string
  last_record_ids: string[]
}

export interface Evidence {
  record_id: string
  quote: string
}

export interface Preference {
  id: string
  statement: string
  confidence: number
  evidence: Evidence[]
  origin: "explicit" | "repeated" | "inferred"
}

export interface TechSignal {
  name: string
  category: string
  count: number
}

export interface Profile {
  schema_version: number
  scope: "global" | "project"
  developer_id: string
  project_id?: string
  analyzer_version: string
  generated_at: string
  generated_from: Cursor
  stats: {
    records: number
    user_messages: number
    assistant_messages: number
    tool_calls: number
    sessions: number
    active_utc_hours: number[]
  }
  tools: { name: string; count: number }[]
  languages: { name: string; count: number }[]
  technical: TechSignal[]
  preferences: Preference[]
  workflow: {
    average_user_message_chars: number
    top_shell_commands: string[]
  }
}

export interface Checkpoint {
  schema_version: number
  analyzer_version: string
  scope: "global" | "project"
  developer_id: string
  project_id?: string
  device_id: string
  version: number
  run_id: string
  cursor: Cursor
  records_processed: number
  updated_at: string
}

export interface AnalysisRunResult {
  ran: boolean
  reason: string
  global_cursor?: Cursor
  project_cursor?: Cursor
  profiles_written: number
}

export interface StatusReport {
  configured: boolean
  paused: boolean
  developer_id?: string
  developer_name?: string
  device_id?: string
  device_name?: string
  project_id?: string
  opencode_project_id?: string
  repository?: string
  data_dir: string
  setup_completed_at?: string
  last_sync_at?: string
  last_sync_error?: string
  pending_records: number
  pending_commits: number
  last_analysis_at?: string
  last_analysis_error?: string
  next_analysis_at?: string
  collected_sessions: number
  restrictions: string[]
}

export interface SyncResult {
  attempted: boolean
  pushed: boolean
  commits: number
  pendingRecords: number
  error?: string
  conflict?: boolean
}

export interface DoctorReport {
  ok: boolean
  checks: { name: string; ok: boolean; detail: string }[]
}
