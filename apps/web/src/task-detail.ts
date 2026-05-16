import type { JsonRecord, PublicArtifactSummary, PublicEventSummary, PublicLogStreamSummary, PublicSessionSummary, PublicTaskDetail } from "./api";
import { summarizeLogStream } from "./board";

const ARTIFACT_KIND_ORDER = ["document", "file", "link", "log", "final_response_url"] as const;
const EVIDENCE_KIND = "agent-pool-e2b-live-readiness-evidence";
const MAX_SAFE_STRING_LENGTH = 600;
const MAX_SAFE_ARRAY_ITEMS = 32;
const MAX_SAFE_OBJECT_KEYS = 80;
const MAX_EVIDENCE_JSON_LENGTH = 18_000;

export type RawLogEntry = {
  readonly id: string;
  readonly stream: string;
  readonly sequence: number | null;
  readonly text: string;
  readonly observedAt: string | null;
  readonly createdAt: string;
};

export type ScrollMetrics = {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
};

export type ArtifactGroup = {
  readonly kind: string;
  readonly label: string;
  readonly artifacts: readonly PublicArtifactSummary[];
};

export type AttemptTimelineItem = {
  readonly session: PublicSessionSummary;
  readonly isLatest: boolean;
  readonly title: string;
  readonly timing: string;
  readonly heartbeat: string;
};

export type SessionInitializationMilestone = {
  readonly id: "sandbox" | "repository" | "setup" | "agent";
  readonly label: string;
  readonly status: "pending" | "running" | "done" | "skipped" | "failed";
  readonly detail: string | null;
};

export type SecurityLifecycleBadge = {
  readonly id: string;
  readonly label: string;
  readonly tone: "neutral" | "good" | "warning" | "danger";
};

export type SecurityTimelineTone = "allowed" | "denied" | "warning" | "blocked";

export type SecurityTimelineItem = {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly tone: SecurityTimelineTone;
  readonly observedAt: string | null;
  readonly securityKind: string;
};

export type FinalResultDetail = {
  readonly recorded: boolean;
  readonly sessionId: string | null;
  readonly recordedAt: string | null;
  readonly text: string | null;
  readonly metadata: JsonRecord;
  readonly urls: readonly string[];
};

export type EvidenceReviewStatus = "passed" | "blocked" | "failed" | "cleanup-risk" | "unknown";

export type EvidenceReviewTone = "good" | "warning" | "danger" | "neutral";

export type EvidenceReviewLink = {
  readonly label: string;
  readonly href: string;
};

export type EvidenceReviewField = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly href?: string | null;
};

export type LiveEvidenceReview = {
  readonly status: EvidenceReviewStatus;
  readonly tone: EvidenceReviewTone;
  readonly markerClassName: string;
  readonly title: string;
  readonly summary: string;
  readonly artifact: PublicArtifactSummary | null;
  readonly generatedAt: string | null;
  readonly launchSpecHash: string | null;
  readonly prUrl: string | null;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly diffStat: string | null;
  readonly checkStatusSummary: string;
  readonly securityVerdict: string;
  readonly cleanupStatus: string;
  readonly snapshotStatus: string;
  readonly blockers: readonly string[];
  readonly fields: readonly EvidenceReviewField[];
  readonly diagnosticsLinks: readonly EvidenceReviewLink[];
  readonly evidenceJson: string | null;
};

export function getSessionInitializationMilestones(
  task: PublicTaskDetail,
  session: PublicSessionSummary | null,
): readonly SessionInitializationMilestone[] {
  if (!session) {
    return [
      { id: "sandbox", label: "Set up cloud container", status: "pending", detail: null },
      { id: "repository", label: "Cloned repository", status: task.runtimeSource ? "pending" : "skipped", detail: task.runtimeSource?.repositoryUrl ?? null },
      { id: "setup", label: "Run setup script", status: "skipped", detail: "No setup script configured." },
      { id: "agent", label: "Started Codex", status: "pending", detail: null },
    ];
  }

  const terminalFailed = session.status === "failed" || session.status === "canceled";
  const sandboxReady = Boolean(session.runtimeSessionId) || ["running", "succeeded", "failed", "canceled"].includes(session.status);
  const codexStarted = hasCodexStartEvent(task, session);

  return [
    {
      id: "sandbox",
      label: "Set up cloud container",
      status: sandboxReady ? "done" : session.status === "starting" ? "running" : terminalFailed ? "failed" : "pending",
      detail: session.runtimeSessionId ? `Sandbox ${session.runtimeSessionId}` : null,
    },
    {
      id: "repository",
      label: "Cloned repository",
      status: task.runtimeSource ? (sandboxReady ? "done" : terminalFailed ? "failed" : "pending") : "skipped",
      detail: task.runtimeSource ? `${task.runtimeSource.repositoryUrl} @ ${task.runtimeSource.baseRef}` : "No GitHub source configured.",
    },
    {
      id: "setup",
      label: "Run setup script",
      status: "skipped",
      detail: "No setup script configured.",
    },
    {
      id: "agent",
      label: "Started Codex",
      status: codexStarted ? "done" : session.status === "running" ? "running" : terminalFailed ? "failed" : "pending",
      detail: readSessionRunner(task, session) ?? null,
    },
  ];
}

export function getRawLogEntries(task: PublicTaskDetail): readonly RawLogEntry[] {
  return task.events
    .filter((event) => event.type === "session.output")
    .map(readRawLogEntry)
    .filter((entry): entry is RawLogEntry => entry !== null)
    .sort((left, right) => {
      const sequenceDelta = (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
      if (sequenceDelta !== 0) return sequenceDelta;

      return Date.parse(left.createdAt) - Date.parse(right.createdAt);
    });
}

export function getSecurityLifecycleBadges(task: PublicTaskDetail): readonly SecurityLifecycleBadge[] {
  const securityEvents = getRawLogEntries(task)
    .map((entry) => parseSecurityLog(entry.text))
    .filter((entry): entry is JsonRecord => entry !== null);
  const hasProxy = securityEvents.some((event) => event.securityKind === "egress" && event.allowed === true);
  const hasDenied = securityEvents.some((event) => event.securityKind === "egress" && event.allowed === false);
  const hasScrubFailure = securityEvents.some((event) => String(event.securityKind) === "credentials-scrub-failed" || (String(event.securityKind) === "credentials-scrubbed" && event.allowed === false));
  const hasScrub = securityEvents.some((event) => String(event.securityKind) === "credentials-scrub-succeeded" || String(event.securityKind) === "credentials-scrubbed");
  const hasDeniedPolicy = securityEvents.some((event) => String(event.securityKind) === "command-policy" && event.allowed === false);
  const hasPolicy = securityEvents.some((event) =>
    ["postflight", "package-install", "package-registry", "command-policy"].includes(String(event.securityKind)),
  );
  const snapshotDecision = [...securityEvents].reverse().find((event) => event.securityKind === "snapshot-decision");
  const snapshotStatus = typeof snapshotDecision?.snapshotEligibilityStatus === "string" ? snapshotDecision.snapshotEligibilityStatus : null;

  return [
    {
      id: "egress",
      label: hasDenied ? "Egress denied" : hasProxy ? "Proxy egress" : "Egress pending",
      tone: hasDenied ? "danger" : hasProxy ? "good" : "neutral",
    },
    {
      id: "policy",
      label: hasDeniedPolicy ? "Command denied" : hasPolicy ? "Policy logged" : "Policy pending",
      tone: hasDeniedPolicy ? "danger" : hasPolicy ? "good" : "neutral",
    },
    {
      id: "scrub",
      label: hasScrubFailure ? "Scrub failed" : hasScrub ? "Credentials scrubbed" : "Scrub pending",
      tone: hasScrubFailure ? "danger" : hasScrub ? "good" : "warning",
    },
    {
      id: "snapshot",
      label: snapshotStatus === "clean" ? "Snapshot clean" : snapshotStatus === "risk" ? "Snapshot risk" : snapshotStatus === "ineligible" ? "Snapshot skipped" : "Snapshot pending",
      tone: snapshotStatus === "clean" ? "good" : snapshotStatus === "risk" ? "warning" : snapshotStatus === "ineligible" ? "warning" : "neutral",
    },
  ];
}

export function getSecurityTimeline(task: PublicTaskDetail): readonly SecurityTimelineItem[] {
  const latestSession = task.latestSession ?? [...task.sessions].sort(compareSessions).at(-1) ?? null;
  const entries: SecurityTimelineInternalItem[] = [];
  let order = 0;

  if (latestSession && isSessionStarted(latestSession)) {
    const startedAt = latestSession.startedAt ?? latestSession.createdAt;
    entries.push({
      id: `${latestSession.id}:sandbox-created`,
      label: "Sandbox created",
      detail: latestSession.runtimeSessionId ? `Provider sandbox ${sanitizeSecurityValue(latestSession.runtimeSessionId)}` : `Session ${sanitizeSecurityValue(latestSession.id)}`,
      tone: "allowed",
      observedAt: startedAt,
      securityKind: "sandbox-created",
      order: order++,
    });

    if (task.runtimeSource) {
      entries.push({
        id: `${latestSession.id}:repo-cloned`,
        label: "Repository cloned",
        detail: `${sanitizeSecurityValue(task.runtimeSource.repositoryUrl)} @ ${sanitizeSecurityValue(task.runtimeSource.baseRef)}`,
        tone: "allowed",
        observedAt: startedAt,
        securityKind: "repository-cloned",
        order: order++,
      });
    }

    if (task.runtimeSource?.commandProfile) {
      entries.push({
        id: `${latestSession.id}:policy-loaded`,
        label: "Command policy loaded",
        detail: sanitizeSecurityValue(task.runtimeSource.commandProfile),
        tone: "allowed",
        observedAt: startedAt,
        securityKind: "command-policy-loaded",
        order: order++,
      });
    }
  }

  getRawLogEntries(task).forEach((entry, index) => {
    const payload = parseSecurityLog(entry.text);
    if (!payload) return;
    entries.push({
      id: `${entry.id}:security`,
      label: labelSecurityTimelineEvent(payload),
      detail: formatSecurityTimelineDetail(payload),
      tone: toneSecurityTimelineEvent(payload),
      observedAt: entry.observedAt ?? entry.createdAt,
      securityKind: String(payload.securityKind ?? "security"),
      order: 1000 + index,
    });
  });

  for (const event of task.events) {
    if (event.type === "session.cleanup" || event.type === "session.cleanup.idempotent") {
      entries.push({
        id: `${event.id}:bridge-cleanup`,
        label: "Bridge cleanup callback",
        detail: "Sandbox process reported cleanup complete",
        tone: "allowed",
        observedAt: event.createdAt,
        securityKind: "bridge-cleanup",
        order: 8000 + order++,
      });
    }
    if (event.type === "runtime_sandbox.cleanup_succeeded") {
      entries.push({
        id: `${event.id}:sandbox-destroyed`,
        label: "Sandbox destroyed",
        detail: "Provider cleanup completed",
        tone: "allowed",
        observedAt: event.createdAt,
        securityKind: "sandbox-destroyed",
        order: 9000 + order++,
      });
    }
    if (event.type === "runtime_sandbox.cleanup_failed") {
      entries.push({
        id: `${event.id}:sandbox-destroy-failed`,
        label: "Sandbox destroy failed",
        detail: formatEventFailureDetail(event.payload),
        tone: "blocked",
        observedAt: event.createdAt,
        securityKind: "sandbox-destroy-failed",
        order: 9000 + order++,
      });
    }
  }

  return entries
    .sort((left, right) => compareTimelineItems(left, right))
    .map(({ order: _order, ...item }) => item);
}

export function formatRawLogEntries(entries: readonly RawLogEntry[]): string {
  return redactUiString(entries.map((entry) => entry.text).join(""));
}

export function formatSafeText(value: string): string {
  return redactUiString(value);
}

export function formatSafeJsonValue(value: unknown): string {
  return formatSafeJson(value);
}

export function summarizeLogFallback(logStreams: readonly PublicLogStreamSummary[]): readonly string[] {
  return logStreams.map(summarizeLogStream);
}

export function shouldFollowRawLogScroll(metrics: ScrollMetrics, thresholdPx = 24): boolean {
  const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceFromBottom <= thresholdPx;
}

export function groupArtifacts(artifacts: readonly PublicArtifactSummary[]): readonly ArtifactGroup[] {
  const grouped = new Map<string, PublicArtifactSummary[]>();
  for (const artifact of artifacts) {
    const group = grouped.get(artifact.kind) ?? [];
    group.push(artifact);
    grouped.set(artifact.kind, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => artifactKindRank(left) - artifactKindRank(right) || left.localeCompare(right))
    .map(([kind, items]) => ({
      kind,
      label: labelArtifactKind(kind),
      artifacts: [...items].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.uri.localeCompare(right.uri)),
    }));
}

export function getArtifactTitle(artifact: PublicArtifactSummary): string {
  return artifact.title?.trim() || artifact.uri.split("/").filter(Boolean).at(-1) || artifact.uri;
}

export function getArtifactStatus(artifact: PublicArtifactSummary): string {
  const status =
    readMetadataString(artifact, "status") ??
    readMetadataString(artifact, "externalStatus") ??
    readMetadataString(artifact, "state");
  return status ?? "unknown";
}

export function getArtifactHref(artifact: PublicArtifactSummary): string | null {
  if (/^https?:\/\//i.test(artifact.uri)) return artifact.uri;

  const metadataUrl = readMetadataString(artifact, "url");
  return metadataUrl && /^https?:\/\//i.test(metadataUrl) ? metadataUrl : null;
}

export function canPreviewArtifact(artifact: PublicArtifactSummary): boolean {
  return artifact.kind === "document" || isSmokeEvidenceArtifact(artifact);
}

export function getArtifactPreviewJson(artifact: PublicArtifactSummary): string {
  return formatSafeJson({
    uri: artifact.uri,
    title: artifact.title,
    metadata: artifact.metadata,
  });
}

export function getEvidenceReviewMarkerClass(status: EvidenceReviewStatus): string {
  return `evidence-review-marker evidence-review-marker-${status}`;
}

export function getLiveEvidenceReview(task: PublicTaskDetail): LiveEvidenceReview {
  const artifact = selectLatestSmokeEvidenceArtifact(task.artifacts);
  const evidence = readRecord(artifact?.metadata.evidence);
  const finalResult = getFinalResultDetail(task);
  const pr = readPrReview(evidence, finalResult.metadata);
  const transcript = readTranscriptReview(evidence, finalResult.metadata);
  const evidenceStatus = readEvidenceStatus(artifact, evidence);
  const blockers = readEvidenceBlockers(artifact, evidence);
  const security = summarizeEvidenceSecurity(evidence, transcript);
  const cleanup = summarizeEvidenceCleanup(task, evidence, transcript);
  const snapshot = summarizeEvidenceSnapshot(evidence, transcript);
  const status = deriveEvidenceReviewStatus({
    artifact,
    evidenceStatus,
    validationStatus: readStringValue(artifact?.metadata.validationStatus),
    cleanup,
    snapshot,
    security,
    blockers,
  });
  const generatedAt = readStringValue(evidence?.generatedAt) ?? readStringValue(artifact?.metadata.generatedAt) ?? artifact?.createdAt ?? null;
  const launchSpecHash = readStringValue(evidence?.launchSpecHash) ?? readStringValue(artifact?.metadata.launchSpecHash);
  const checkStatusSummary = summarizePrChecks(pr);
  const title = labelEvidenceReviewStatus(status);
  const summary = summarizeEvidenceReview(status, artifact, blockers, cleanup, snapshot);
  const fields: EvidenceReviewField[] = [
    { id: "pr", label: "PR", value: pr.url ?? "not observed", href: pr.url },
    { id: "branch", label: "Branch", value: pr.branch ?? "not observed" },
    { id: "commit", label: "Commit", value: pr.commit ?? "not observed" },
    { id: "diff", label: "Diff", value: pr.diffStat ?? "not observed" },
    { id: "checks", label: "Checks", value: checkStatusSummary },
    { id: "security", label: "Security", value: security.label },
    { id: "cleanup", label: "Cleanup", value: cleanup.label },
    { id: "snapshot", label: "Snapshot", value: snapshot.label },
  ];

  return {
    status,
    tone: toneEvidenceReviewStatus(status),
    markerClassName: getEvidenceReviewMarkerClass(status),
    title,
    summary,
    artifact,
    generatedAt,
    launchSpecHash,
    prUrl: pr.url,
    branch: pr.branch,
    commit: pr.commit,
    diffStat: pr.diffStat,
    checkStatusSummary,
    securityVerdict: security.label,
    cleanupStatus: cleanup.label,
    snapshotStatus: snapshot.label,
    blockers,
    fields,
    diagnosticsLinks: buildEvidenceDiagnosticsLinks(task, artifact),
    evidenceJson: evidence ? formatSafeJson(evidence) : null,
  };
}

export function getAttemptTimeline(task: PublicTaskDetail): readonly AttemptTimelineItem[] {
  const latestSessionId = task.latestSession?.id ?? task.sessions.at(-1)?.id ?? null;

  return [...task.sessions]
    .sort((left, right) => left.attemptNumber - right.attemptNumber || Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((session) => ({
      session,
      isLatest: session.id === latestSessionId,
      title: `Attempt ${session.attemptNumber}`,
      timing: formatAttemptTiming(session),
      heartbeat: formatAttemptHeartbeat(session),
    }));
}

export function getFinalResultDetail(task: PublicTaskDetail): FinalResultDetail {
  const session = [...task.sessions].reverse().find((candidate) => candidate.finalResponseRecordedAt || candidate.finalResponseText) ?? null;
  const urls = task.artifacts.filter((artifact) => artifact.kind === "final_response_url").map((artifact) => artifact.uri);

  return {
    recorded: Boolean(session?.finalResponseRecordedAt || session?.finalResponseText || urls.length > 0),
    sessionId: session?.id ?? null,
    recordedAt: session?.finalResponseRecordedAt ?? null,
    text: session?.finalResponseText ?? null,
    metadata: session?.finalResponseMetadata ?? {},
    urls,
  };
}

function readRawLogEntry(event: PublicEventSummary): RawLogEntry | null {
  const text = readPayloadString(event, "text");
  if (text === null) return null;

  return {
    id: event.id,
    stream: readPayloadString(event, "stream") ?? "combined",
    sequence: readPayloadNumber(event, "sequence"),
    text,
    observedAt: readPayloadString(event, "observedAt"),
    createdAt: event.createdAt,
  };
}

function isSmokeEvidenceArtifact(artifact: PublicArtifactSummary): boolean {
  return artifact.metadata.source === "smoke:e2b" || artifact.metadata.evidenceKind === EVIDENCE_KIND;
}

function selectLatestSmokeEvidenceArtifact(artifacts: readonly PublicArtifactSummary[]): PublicArtifactSummary | null {
  return [...artifacts]
    .filter(isSmokeEvidenceArtifact)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id))[0] ?? null;
}

type PrReview = {
  readonly url: string | null;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly diffStat: string | null;
  readonly checkStatus: string | null;
  readonly checks: JsonRecord;
};

type TranscriptReview = {
  readonly cleanupObserved: boolean | null;
  readonly snapshotStatus: string | null;
  readonly credentialScrubStatus: string | null;
  readonly egressDenied: number | null;
  readonly policyDenied: number | null;
};

type StatusSummary = {
  readonly key: string;
  readonly label: string;
};

function readPrReview(evidence: JsonRecord | null, finalMetadata: JsonRecord): PrReview {
  const stageDiagnostics = readRecord(evidence?.stageDiagnostics);
  const statusDiagnostics = readRecord(readRecord(evidence?.statusResult)?.diagnostics);
  const metadataPr = readRecord(finalMetadata.pr);
  const stagePr = readRecord(stageDiagnostics?.pr) ?? readRecord(statusDiagnostics?.pr);
  const postflight = readRecord(finalMetadata.postflight);
  const githubPullRequest = readRecord(postflight?.githubPullRequest);
  const pr = metadataPr ?? stagePr ?? githubPullRequest ?? {};
  const checks =
    readRecord(pr.checks) ??
    readRecord(stagePr?.checks) ??
    readRecord(githubPullRequest?.checks) ??
    readRecord(postflight?.checkStatusSummary) ??
    {};

  return {
    url: sanitizeMaybeUrl(readStringValue(pr.url) ?? readStringValue(stagePr?.url) ?? readStringValue(githubPullRequest?.url) ?? readStringValue(finalMetadata.pullRequestUrl)),
    branch: safeDisplayString(readStringValue(pr.branch) ?? readStringValue(stagePr?.branch) ?? readStringValue(githubPullRequest?.branch) ?? readStringValue(postflight?.branch)),
    commit: safeDisplayString(readStringValue(pr.finalCommitSha) ?? readStringValue(stagePr?.finalCommitSha) ?? readStringValue(githubPullRequest?.finalCommitSha) ?? readStringValue(postflight?.headSha)),
    diffStat: safeDisplayString(readStringValue(pr.diffStat) ?? readStringValue(stagePr?.diffStat) ?? readStringValue(postflight?.diffStat)),
    checkStatus: safeDisplayString(readStringValue(pr.checkStatus) ?? readStringValue(stagePr?.checkStatus) ?? readStringValue(checks.status)),
    checks,
  };
}

function readTranscriptReview(evidence: JsonRecord | null, finalMetadata: JsonRecord): TranscriptReview {
  const stageDiagnostics = readRecord(evidence?.stageDiagnostics);
  const statusDiagnostics = readRecord(readRecord(evidence?.statusResult)?.diagnostics);
  const transcript =
    readRecord(finalMetadata.transcriptSummary) ??
    readRecord(stageDiagnostics?.transcriptSummary) ??
    readRecord(statusDiagnostics?.transcriptSummary) ??
    {};
  const egress = readRecord(transcript.egress);
  const policy = readRecord(transcript.policy);

  return {
    cleanupObserved: readBoolean(transcript.cleanupObserved),
    snapshotStatus: safeDisplayString(readStringValue(transcript.snapshotStatus)),
    credentialScrubStatus: safeDisplayString(readStringValue(transcript.credentialScrubStatus)),
    egressDenied: readNumberValue(transcript.egressDenied) ?? readNumberValue(egress?.denied),
    policyDenied: readNumberValue(transcript.policyDenied) ?? readNumberValue(policy?.denied),
  };
}

function readEvidenceStatus(artifact: PublicArtifactSummary | null, evidence: JsonRecord | null): string | null {
  return readStringValue(evidence?.status) ?? readStringValue(artifact?.metadata.evidenceStatus) ?? readStringValue(artifact?.metadata.status);
}

function readEvidenceBlockers(artifact: PublicArtifactSummary | null, evidence: JsonRecord | null): readonly string[] {
  const source = Array.isArray(evidence?.blockers) ? evidence?.blockers : Array.isArray(artifact?.metadata.blockers) ? artifact?.metadata.blockers : [];
  return source
    .map((entry) => {
      const record = readRecord(entry);
      const field = safeDisplayString(readStringValue(record?.field));
      const reason = safeDisplayString(readStringValue(record?.reason));
      if (field && reason) return `${field}: ${reason}`;
      return reason ?? field;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function summarizeEvidenceSecurity(evidence: JsonRecord | null, transcript: TranscriptReview): StatusSummary {
  const securityReadiness = readRecord(evidence?.securityReadiness);
  const network = readRecord(securityReadiness?.network);
  const credentials = readRecord(securityReadiness?.credentials);
  const rawSecretsPresent = readBoolean(credentials?.rawSecretsPresent);
  const proxyOnly = readBoolean(network?.proxyOnly);
  const egressDenied = transcript.egressDenied ?? 0;
  const policyDenied = transcript.policyDenied ?? 0;
  const scrubStatus = transcript.credentialScrubStatus;

  if (rawSecretsPresent === true || egressDenied > 0 || policyDenied > 0 || scrubStatus === "failed") {
    return { key: "risk", label: "risk detected" };
  }

  if (proxyOnly === true || scrubStatus === "succeeded") {
    return { key: "passed", label: proxyOnly === true ? "proxy-only ready" : "credentials scrubbed" };
  }

  return { key: "unknown", label: "not observed" };
}

function summarizeEvidenceCleanup(task: PublicTaskDetail, evidence: JsonRecord | null, transcript: TranscriptReview): StatusSummary {
  const cleanupStage = readStageStatus(evidence, "cleanup");
  const providerFailed = task.events.some((event) => event.type === "runtime_sandbox.cleanup_failed");
  const providerSucceeded = task.events.some((event) => event.type === "runtime_sandbox.cleanup_succeeded");
  const bridgeCleanup = task.events.some((event) => event.type === "session.cleanup" || event.type === "session.cleanup.idempotent");

  if (providerFailed || cleanupStage === "failed") return { key: "failed", label: "provider cleanup failed" };
  if (providerSucceeded) return { key: "passed", label: "provider destroyed" };
  if (cleanupStage === "passed" || transcript.cleanupObserved === true || bridgeCleanup) return { key: "passed", label: "cleanup observed" };
  if (cleanupStage === "running" || cleanupStage === "pending") return { key: cleanupStage, label: labelFromKebab(cleanupStage) };
  return { key: "unknown", label: "not observed" };
}

function summarizeEvidenceSnapshot(evidence: JsonRecord | null, transcript: TranscriptReview): StatusSummary {
  const snapshotDecision = readRecord(evidence?.snapshotDecision);
  const stageStatus = readStageStatus(evidence, "snapshot");
  const status = transcript.snapshotStatus ?? readStringValue(snapshotDecision?.status) ?? stageStatus;
  if (!status) return { key: "unknown", label: "not observed" };
  const safe = safeDisplayString(status) ?? "unknown";
  return { key: safe, label: labelFromKebab(safe) };
}

function readStageStatus(evidence: JsonRecord | null, id: string): string | null {
  const diagnostics = readRecord(evidence?.stageDiagnostics);
  const stages = Array.isArray(diagnostics?.stages) ? diagnostics.stages : [];
  for (const stage of stages) {
    const record = readRecord(stage);
    if (record?.id === id) return safeDisplayString(readStringValue(record.status));
  }
  return null;
}

function deriveEvidenceReviewStatus(input: {
  readonly artifact: PublicArtifactSummary | null;
  readonly evidenceStatus: string | null;
  readonly validationStatus: string | null;
  readonly cleanup: StatusSummary;
  readonly snapshot: StatusSummary;
  readonly security: StatusSummary;
  readonly blockers: readonly string[];
}): EvidenceReviewStatus {
  if (!input.artifact) return "unknown";
  if (input.validationStatus === "invalid") return "failed";
  if (input.evidenceStatus === "blocked" || input.blockers.length > 0) return "blocked";
  if (input.evidenceStatus === "failed" || input.security.key === "risk") return "failed";
  if (input.cleanup.key === "failed" || ["risk", "failed"].includes(input.snapshot.key)) return "cleanup-risk";
  if (input.evidenceStatus === "pass") return "passed";
  return "unknown";
}

function labelEvidenceReviewStatus(status: EvidenceReviewStatus): string {
  switch (status) {
    case "passed":
      return "Live evidence passed";
    case "blocked":
      return "Live evidence blocked";
    case "failed":
      return "Live evidence failed";
    case "cleanup-risk":
      return "Cleanup risk";
    case "unknown":
      return "Live evidence unknown";
  }
}

function toneEvidenceReviewStatus(status: EvidenceReviewStatus): EvidenceReviewTone {
  switch (status) {
    case "passed":
      return "good";
    case "blocked":
    case "cleanup-risk":
      return "warning";
    case "failed":
      return "danger";
    case "unknown":
      return "neutral";
  }
}

function summarizeEvidenceReview(
  status: EvidenceReviewStatus,
  artifact: PublicArtifactSummary | null,
  blockers: readonly string[],
  cleanup: StatusSummary,
  snapshot: StatusSummary,
): string {
  if (!artifact) return "No live E2B evidence artifact has been persisted for this task.";
  if (blockers.length > 0) return blockers[0] ?? "Evidence is blocked.";
  if (status === "cleanup-risk") return `Cleanup requires review: ${cleanup.label}; snapshot ${snapshot.label}.`;
  if (status === "passed") return "PR, security, cleanup, and snapshot evidence are available from the latest smoke run.";
  if (status === "failed") return "The latest live smoke evidence reports a failed execution or security verdict.";
  if (status === "blocked") return "The latest live smoke evidence is blocked by missing prerequisites or runtime setup.";
  return "Evidence is present, but the latest run has not produced a conclusive live status.";
}

function summarizePrChecks(pr: PrReview): string {
  const total = readNumberValue(pr.checks.total);
  const passed = readNumberValue(pr.checks.passed);
  const failed = readNumberValue(pr.checks.failed);
  const status = pr.checkStatus ?? safeDisplayString(readStringValue(pr.checks.status));
  if (typeof total === "number" && typeof passed === "number") {
    const suffix = typeof failed === "number" && failed > 0 ? `, ${failed} failed` : "";
    return `${status ?? "checks"} (${passed}/${total} passed${suffix})`;
  }
  return status ?? "not observed";
}

function buildEvidenceDiagnosticsLinks(task: PublicTaskDetail, artifact: PublicArtifactSummary | null): readonly EvidenceReviewLink[] {
  const projectId = encodeURIComponent(task.projectId);
  const taskId = encodeURIComponent(task.id);
  const links: EvidenceReviewLink[] = [
    { label: "Task JSON", href: `/api/public/projects/${projectId}/tasks/${taskId}` },
    { label: "Task artifacts", href: `/api/public/projects/${projectId}/tasks/${taskId}/artifacts` },
  ];
  const sessionId = artifact?.sessionId ?? task.latestSession?.id ?? null;
  if (sessionId) {
    links.push({
      label: "Session artifacts",
      href: `/api/public/projects/${projectId}/tasks/${taskId}/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    });
  }
  return links;
}

function parseSecurityLog(text: string): JsonRecord | null {
  const firstLine = text.split("\n").find((line) => line.trim().startsWith("{"));
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as JsonRecord;
    return record.type === "security" || record.type === "security.egress" || record.type === "security.package" ? record : null;
  } catch {
    return null;
  }
}

type SecurityTimelineInternalItem = SecurityTimelineItem & {
  readonly order: number;
};

function compareSessions(left: PublicSessionSummary, right: PublicSessionSummary): number {
  return left.attemptNumber - right.attemptNumber || Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function isSessionStarted(session: PublicSessionSummary): boolean {
  return Boolean(session.runtimeSessionId) || ["starting", "running", "succeeded", "failed", "canceled", "lost"].includes(session.status);
}

function compareTimelineItems(left: SecurityTimelineInternalItem, right: SecurityTimelineInternalItem): number {
  const leftTime = left.observedAt ? Date.parse(left.observedAt) : Number.MAX_SAFE_INTEGER;
  const rightTime = right.observedAt ? Date.parse(right.observedAt) : Number.MAX_SAFE_INTEGER;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return left.order - right.order;
}

function labelSecurityTimelineEvent(event: JsonRecord): string {
  const kind = String(event.securityKind ?? "");
  switch (kind) {
    case "dependency-install-started":
      return "Install started";
    case "dependency-install-finished":
      return "Install complete";
    case "dependency-install-failed":
      return "Install blocked";
    case "package-install":
      return "Package install audit";
    case "package-registry":
      return event.allowed === false ? "Package denied" : "Package allowed";
    case "command-policy":
      return event.allowed === false ? "Command denied" : "Command allowed";
    case "egress":
    case "egress-denied":
      return event.allowed === false ? "Egress denied" : "Egress allowed";
    case "credentials-scrub-started":
      return "Credential scrub started";
    case "credentials-scrub-succeeded":
    case "credentials-scrubbed":
      return event.allowed === false ? "Credential scrub failed" : "Credentials scrubbed";
    case "credentials-scrub-failed":
      return "Credential scrub failed";
    case "snapshot-decision":
      return "Snapshot decision";
    case "postflight":
      return "Postflight checks";
    default:
      return kind ? labelFromKebab(kind) : "Security event";
  }
}

function toneSecurityTimelineEvent(event: JsonRecord): SecurityTimelineTone {
  const kind = String(event.securityKind ?? "");
  if (kind === "dependency-install-failed" || kind === "credentials-scrub-failed") return "blocked";
  if (kind === "snapshot-decision") {
    const status = String(event.snapshotEligibilityStatus ?? "");
    if (status === "risk" || status === "ineligible") return "warning";
    if (event.allowed === false) return "warning";
    return "allowed";
  }
  if (event.allowed === false) {
    if (kind === "credentials-scrubbed") return "blocked";
    return "denied";
  }
  if (event.decision === "denied") return "denied";
  if (event.decision === "failed") return "blocked";
  if (event.lockfileChanged === true) return "warning";
  return "allowed";
}

function formatSecurityTimelineDetail(event: JsonRecord): string | null {
  const parts: string[] = [];
  const kind = String(event.securityKind ?? "");

  appendSecurityPart(parts, "policy", event.policy);
  appendSecurityPart(parts, "host", event.host);
  appendSecurityPart(parts, "method", event.method);
  appendSecurityPart(parts, "command", event.command);
  appendSecurityPart(parts, "registry", event.registryHost);
  appendPackagePart(parts, event);
  appendSecurityPart(parts, "reason", event.reason);
  appendSecurityPart(parts, "status", event.snapshotEligibilityStatus);
  appendSecurityPart(parts, "risk", event.snapshotRiskReasons);
  appendSecurityPart(parts, "remaining", event.remainingCount);

  if (event.lockfileChanged === true) parts.push("lockfile changed");
  if (event.lockfileChanged === false && kind.startsWith("dependency-install")) parts.push("lockfile unchanged");

  return parts.length > 0 ? parts.join(" · ") : null;
}

function appendPackagePart(parts: string[], event: JsonRecord): void {
  const packageName = safeSecurityPart("package", event.packageName);
  if (!packageName) return;

  const requested = safeSecurityPart("requested", event.requestedVersion);
  const resolved = safeSecurityPart("resolved", event.resolvedVersion);
  if (requested || resolved) {
    parts.push(`package ${packageName}${requested ? ` requested ${requested}` : ""}${resolved ? ` resolved ${resolved}` : ""}`);
    return;
  }

  parts.push(`package ${packageName}`);
}

function appendSecurityPart(parts: string[], label: string, value: unknown): void {
  const safe = safeSecurityPart(label, value);
  if (!safe) return;
  parts.push(`${label} ${safe}`);
}

function safeSecurityPart(label: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const values = value.map((entry) => sanitizeSecurityValue(entry, label)).filter(Boolean);
    return values.length > 0 ? values.join(", ") : null;
  }
  const safe = sanitizeSecurityValue(value, label);
  return safe || null;
}

function sanitizeSecurityValue(value: unknown, key = ""): string {
  if (/token|secret|password|key|proxy/i.test(key)) return "[redacted]";
  const raw = typeof value === "string" ? value : String(value);
  return raw
    .replace(/\/\/([^:/\s]+):([^@\s]+)@/g, "//$1:[redacted]@")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|e2b_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/\b(?:short-lived-github-token|codex-secret|bridge-token|session-secret)\b/gi, "[redacted]");
}

function formatEventFailureDetail(payload: JsonRecord): string | null {
  return safeSecurityPart("reason", payload.errorMessage ?? payload.reason ?? payload.error) ?? "Provider cleanup did not complete";
}

function labelFromKebab(value: string): string {
  return value
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function hasCodexStartEvent(task: PublicTaskDetail, session: PublicSessionSummary): boolean {
  return task.events.some(
    (event) =>
      event.sessionId === session.id &&
      event.type === "session.output" &&
      typeof event.payload.text === "string" &&
      /codex runner starting|AGENT_POOL_BRIDGE_RUNNER.+codex|command\.started/i.test(event.payload.text),
  ) || readSessionRunner(task, session) === "codex";
}

function readSessionRunner(task: PublicTaskDetail, session: PublicSessionSummary): string | null {
  const metadataRunner = session.finalResponseMetadata.runner;
  if (typeof metadataRunner === "string" && metadataRunner.trim()) return metadataRunner.trim();
  const output = task.events.find(
    (event) =>
      event.sessionId === session.id &&
      event.type === "session.output" &&
      typeof event.payload.text === "string" &&
      event.payload.text.includes("codex runner starting"),
  );
  return output ? "codex" : null;
}

function readPayloadString(event: PublicEventSummary, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" ? value : null;
}

function readPayloadNumber(event: PublicEventSummary, key: string): number | null {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sanitizeMaybeUrl(value: string | null): string | null {
  const safe = safeDisplayString(value);
  return safe && /^https?:\/\//i.test(safe) ? safe : null;
}

function safeDisplayString(value: string | null): string | null {
  if (!value) return null;
  const safe = redactUiString(value);
  return safe.length > MAX_SAFE_STRING_LENGTH ? `${safe.slice(0, MAX_SAFE_STRING_LENGTH)}... [truncated]` : safe;
}

function formatSafeJson(value: unknown): string {
  const json = JSON.stringify(redactUiValue(value), null, 2);
  if (json.length <= MAX_EVIDENCE_JSON_LENGTH) return json;
  return `${json.slice(0, MAX_EVIDENCE_JSON_LENGTH)}\n... [truncated]`;
}

function redactUiValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return safeDisplayStringForKey(value, key);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_SAFE_ARRAY_ITEMS).map((item) => redactUiValue(item, key, depth + 1));
    if (value.length > MAX_SAFE_ARRAY_ITEMS) items.push(`[truncated ${value.length - MAX_SAFE_ARRAY_ITEMS} items]`);
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_SAFE_OBJECT_KEYS);
  const redacted: Record<string, unknown> = {};
  for (const [childKey, childValue] of entries) {
    redacted[childKey] = /token|secret|password|api[-_]?key|private[-_]?key|proxy|authorization|cookie|callback/i.test(childKey)
      ? "[redacted]"
      : redactUiValue(childValue, childKey, depth + 1);
  }
  const totalKeys = Object.keys(value as Record<string, unknown>).length;
  if (totalKeys > MAX_SAFE_OBJECT_KEYS) redacted.__truncatedKeys = totalKeys - MAX_SAFE_OBJECT_KEYS;
  return redacted;
}

function safeDisplayStringForKey(value: string, key: string): string {
  const redacted = /token|secret|password|api[-_]?key|private[-_]?key|proxy|authorization|cookie|callback/i.test(key)
    ? "[redacted]"
    : redactUiString(value);
  return redacted.length > MAX_SAFE_STRING_LENGTH ? `${redacted.slice(0, MAX_SAFE_STRING_LENGTH)}... [truncated]` : redacted;
}

function artifactKindRank(kind: string): number {
  const index = ARTIFACT_KIND_ORDER.findIndex((candidate) => candidate === kind);
  return index === -1 ? ARTIFACT_KIND_ORDER.length : index;
}

function labelArtifactKind(kind: string): string {
  switch (kind) {
    case "final_response_url":
      return "Final Response URLs";
    case "document":
      return "Documents";
    case "file":
      return "Files";
    case "link":
      return "Links";
    case "log":
      return "Logs";
    default:
      return kind.replace(/_/g, " ");
  }
}

function readMetadataString(artifact: PublicArtifactSummary, key: string): string | null {
  const value = artifact.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function redactUiString(value: string): string {
  return value
    .replace(/\/\/([^:/\s]+):([^@\s]+)@/g, "//$1:[redacted]@")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|e2b_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/\b(?:short-lived-github-token|codex-secret|bridge-token|session-secret|callback-token|proxy-token|service-token)\b/gi, "[redacted]")
    .replace(/~\/\.agent-pool\/data\/agent-pool\.db/g, "[redacted-db-path]")
    .replace(/(?:\/[^\s"'`]+)+\/agent-pool\.db/g, "[redacted-db-path]");
}

function formatAttemptTiming(session: PublicSessionSummary): string {
  if (session.startedAt && session.endedAt) return `${session.startedAt} to ${session.endedAt}`;
  if (session.startedAt) return `started ${session.startedAt}`;
  if (session.endedAt) return `ended ${session.endedAt}`;
  return `created ${session.createdAt}`;
}

function formatAttemptHeartbeat(session: PublicSessionSummary): string {
  if (session.lostAt) return `lost ${session.lostAt}`;
  if (session.staleAt) return `stale ${session.staleAt}`;
  if (session.lastHeartbeatAt) return `${session.heartbeatStatus} ${session.lastHeartbeatAt}`;
  return session.heartbeatStatus;
}
