import type {
  PublicApiClient,
  PublicPlannedUpload,
  PublicSessionSummary,
  PublicSteeringAttachmentReference,
  PublicSteeringMessageSummary,
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

export type VisibleSteeringMessage = PublicSteeringMessageSummary & {
  readonly displayStatus: "Queued" | "Failed";
};

export type InterruptConfirmationState = "idle" | "confirming";

export type SteeringInterruptPayload = {
  readonly message: string;
  readonly steeringContext: {
    readonly source: "web";
    readonly messages: readonly {
      readonly id: string;
      readonly status: string;
      readonly body: string;
      readonly attachments: readonly PublicSteeringAttachmentReference[];
    }[];
  };
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

export function getVisibleSteeringMessages(task: PublicTaskDetail): readonly VisibleSteeringMessage[] {
  return task.steeringMessages
    .filter((message) => message.status === "queued" || message.status === "failed")
    .map((message) => ({
      ...message,
      displayStatus: message.status === "failed" ? "Failed" : "Queued",
    }));
}

export function getSteeringInterruptAvailability(
  task: PublicTaskDetail | null,
  activeSession: PublicSessionSummary | null,
): SteeringAvailability {
  const steeringAvailability = getSteeringAvailability(task, activeSession);
  if (!steeringAvailability.available || !task) return steeringAvailability;

  if (getVisibleSteeringMessages(task).length === 0) {
    return { available: false, reason: "No queued steering is available to escalate." };
  }

  return { available: true, reason: null };
}

export function startInterruptConfirmation(
  current: InterruptConfirmationState,
  availability: SteeringAvailability,
): InterruptConfirmationState {
  return availability.available ? "confirming" : current;
}

export function cancelInterruptConfirmation(): InterruptConfirmationState {
  return "idle";
}

export function buildSteeringInterruptPayload(task: PublicTaskDetail): SteeringInterruptPayload {
  const messages = getVisibleSteeringMessages(task).map((message) => ({
    id: message.id,
    status: message.status,
    body: message.body,
    attachments: message.attachments,
  }));

  return {
    message: `Interrupt requested with ${messages.length} queued steering ${messages.length === 1 ? "message" : "messages"}.`,
    steeringContext: {
      source: "web",
      messages,
    },
  };
}

export function shouldUseIncomingTaskDetail(current: PublicTaskDetail | null, incoming: PublicTaskDetail): boolean {
  if (!current || current.id !== incoming.id) return true;

  return readDetailFreshness(incoming) >= readDetailFreshness(current);
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

function readDetailFreshness(task: PublicTaskDetail): number {
  return Math.max(
    readTimestamp(task.updatedAt),
    ...task.events.map((event) => readTimestamp(event.createdAt)),
    ...task.steeringMessages.map((message) => readTimestamp(message.deliveredAt ?? message.createdAt)),
  );
}

function readTimestamp(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
