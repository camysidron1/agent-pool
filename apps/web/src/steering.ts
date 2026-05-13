import type {
  PublicApiClient,
  PublicPlannedUpload,
  PublicSessionSummary,
  PublicSteeringAttachmentReference,
  PublicSteeringMutation,
  PublicTaskDetail,
} from "./api";

export type SteeringAvailability = {
  readonly available: boolean;
  readonly reason: string | null;
};

export type SteeringFileSelection = {
  readonly name: string;
  readonly type?: string | null;
};

export type SubmitSteeringDraftInput = {
  readonly api: Pick<PublicApiClient, "planProjectUpload" | "steerSession">;
  readonly projectId: string;
  readonly task: PublicTaskDetail;
  readonly activeSession: PublicSessionSummary | null;
  readonly body: string;
  readonly files: readonly SteeringFileSelection[];
};

export function getSteeringAvailability(task: PublicTaskDetail | null, activeSession: PublicSessionSummary | null): SteeringAvailability {
  if (!task) {
    return { available: false, reason: "Task detail is loading." };
  }

  if (task.status !== "running") {
    return { available: false, reason: `Steering is unavailable while the task is ${task.status}.` };
  }

  if (!activeSession) {
    return { available: false, reason: "No active session is available." };
  }

  if (activeSession.status !== "running") {
    return { available: false, reason: `Steering is unavailable while the session is ${activeSession.status}.` };
  }

  return { available: true, reason: null };
}

export async function submitSteeringDraft(input: SubmitSteeringDraftInput): Promise<PublicSteeringMutation> {
  const availability = getSteeringAvailability(input.task, input.activeSession);
  if (!availability.available || !input.activeSession) {
    throw new Error(availability.reason ?? "Steering is unavailable.");
  }

  const body = input.body.trim();
  if (!body) {
    throw new Error("Steering message is required.");
  }

  const attachments = await planSteeringAttachments(input);
  return input.api.steerSession(input.projectId, input.task.id, input.activeSession.id, {
    body,
    attachments,
  });
}

export function plannedUploadToSteeringAttachment(
  upload: PublicPlannedUpload,
  file: SteeringFileSelection,
): PublicSteeringAttachmentReference {
  return {
    key: upload.key,
    bucket: upload.bucket,
    fileName: file.name,
    contentType: normalizeContentType(file.type ?? upload.contentType),
  };
}

async function planSteeringAttachments(input: SubmitSteeringDraftInput): Promise<readonly PublicSteeringAttachmentReference[]> {
  const activeSession = input.activeSession;
  if (!activeSession || input.files.length === 0) return [];

  return Promise.all(
    input.files.map(async (file) => {
      const plan = await input.api.planProjectUpload(input.projectId, {
        taskId: input.task.id,
        sessionId: activeSession.id,
        fileName: file.name,
        contentType: normalizeContentType(file.type),
      });

      return plannedUploadToSteeringAttachment(plan.upload, file);
    }),
  );
}

function normalizeContentType(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
