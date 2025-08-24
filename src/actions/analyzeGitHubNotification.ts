import type {
  Action,
  IAgentRuntime,
  Memory,
  ActionExample,
  MemoryMetadata,
  ActionResult,
  State,
  HandlerCallback,
  UUID,
} from "@elizaos/core";
import { logger, ModelType, parseJSONObjectFromText, stringToUuid } from "@elizaos/core";
import { GitHubNotification } from "../services/githubService";

/**
 * Generates a consistent internal room ID for the agent following the email plugin pattern
 */
const getInternalRoomIdForAgent = (agentId: UUID): UUID => {
  // Take first 13 chars of agentId to create a unique suffix (following email plugin pattern)
  const agentSpecificRoomSuffix = agentId.slice(0, 13);

  // Use stringToUuid with a clean, short seed string for proper UUID generation
  return stringToUuid(`pingpal-github-internal-room-${agentSpecificRoomSuffix}`);
};

// In-memory cache for performance optimization only (optional enhancement)
const processedNotificationIds = new Set<string>();
const MAX_CACHE_SIZE = 1000; // Keep last 1000 processed notification IDs in memory for performance

export const analyzeGitHubNotificationAction: Action = {
  name: "ANALYZE_GITHUB_NOTIFICATION",
  similes: ["analyze github notification", "process github alert"],
  description: "Analyzes GitHub notification importance using LLM",
  examples: [] as ActionExample[][],

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return !!(message.content as any)?.githubNotification;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const notification = (message.content as any)
        .githubNotification as GitHubNotification;

      logger.info(
        {
          notificationId: notification.id,
          reason: notification.reason,
          repository: notification.repository.full_name,
          subject: notification.subject.title,
          type: notification.subject.type,
        },
        "[PingPal GitHub] Analyzing GitHub notification...",
      );

      // DATABASE-FIRST DEDUPLICATION - Following email plugin pattern
      // Check database as PRIMARY source of truth for persistent deduplication
      try {
        const processedMemories = await runtime.getMemories({
          tableName: "pingpal_github_processed",
          agentId: runtime.agentId,
          count: 200, // Check last 200 processed notifications
        });

        const isDuplicate = processedMemories.some((memory) => {
          const metadata = memory.metadata as Record<string, unknown>;
          return metadata?.githubNotificationId === notification.id;
        });

        if (isDuplicate) {
          logger.info(
            { notificationId: notification.id },
            "[PingPal GitHub] Duplicate notification detected (database). Skipping.",
          );

          // Add to in-memory cache for performance optimization
          processedNotificationIds.add(notification.id);

          return {
            success: true,
            text: `Skipped duplicate notification ${notification.id}`,
            data: { skipped: true, reason: "duplicate" },
          };
        }
      } catch (dbError) {
        logger.warn(
          { error: dbError, notificationId: notification.id },
          "[PingPal GitHub] Error checking database for duplicates. Falling back to in-memory check only.",
        );

        // Fallback to in-memory check if database fails
        if (processedNotificationIds.has(notification.id)) {
          logger.info(
            { notificationId: notification.id },
            "[PingPal GitHub] Duplicate notification detected (in-memory fallback). Skipping.",
          );
          return {
            success: true,
            text: `Skipped duplicate notification ${notification.id}`,
            data: { skipped: true, reason: "duplicate" },
          };
        }
      }

      // Perform LLM analysis
      const targetUsername = process.env.PINGPAL_TARGET_GITHUB_USERNAME;
      const analysisResult = await performImportanceAnalysis(
        runtime,
        notification,
        targetUsername || "",
      );

      // Log processed notification to database FIRST (primary persistence)
      // This must succeed for proper deduplication across restarts
      await logProcessedNotification(runtime, notification, analysisResult, message.roomId);

      // Add to in-memory cache for performance optimization (secondary)
      processedNotificationIds.add(notification.id);

      // Maintain cache size limit
      if (processedNotificationIds.size > MAX_CACHE_SIZE) {
        // Remove oldest entries (in a Set, the first entries are the oldest)
        const oldestIds = Array.from(processedNotificationIds).slice(0, processedNotificationIds.size - MAX_CACHE_SIZE + 100);
        oldestIds.forEach(id => processedNotificationIds.delete(id));
      }

      // Send Telegram notification if important
      if (analysisResult && analysisResult.important) {
        // Create a new memory for the Telegram action
        const telegramMemory: Memory = {
          id: crypto.randomUUID(),
          entityId: runtime.agentId,
          roomId: message.roomId,
          agentId: runtime.agentId,
          content: {
            text: "Send Telegram notification",
            githubNotification: notification,
            analysisReason: analysisResult.reason,
          },
          createdAt: Date.now(),
        };

        // Find and execute the SEND_TELEGRAM_NOTIFICATION action
        const sendTelegramAction = runtime.actions?.find(
          (action) => action.name === "SEND_TELEGRAM_NOTIFICATION",
        );

        if (sendTelegramAction) {
          if (await sendTelegramAction.validate(runtime, telegramMemory)) {
            await sendTelegramAction.handler(runtime, telegramMemory);
          }
        } else {
          logger.warn(
            "[PingPal GitHub] SEND_TELEGRAM_NOTIFICATION action not found",
          );
        }
      }

      return {
        success: true,
        text: `Analyzed notification ${notification.id}. Important: ${
          analysisResult?.important || false
        }`,
        data: {
          notificationId: notification.id,
          important: analysisResult?.important || false,
          reason: analysisResult?.reason || "Analysis failed",
        },
      };
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack
          } : String(error),
          notificationId: (message.content as any)?.githubNotification?.id
        },
        "[PingPal GitHub] Failed to analyze GitHub notification",
      );
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
};

async function performImportanceAnalysis(
  runtime: IAgentRuntime,
  notification: GitHubNotification,
  targetUsername: string,
): Promise<{ important: boolean; reason: string } | null> {
  const prompt = `You are an assistant helping filter GitHub notifications. Analyze the following notification for '${targetUsername}'. Determine if this notification requires urgent attention or action. Consider factors like direct mentions (@username), pull request review requests, issue assignments, critical discussions, deadlines, blockers, or tasks requiring immediate response.

Notification Details:
- Type: ${notification.reason}
- Repository: ${notification.repository.full_name}
- Subject: ${notification.subject.title}
- Subject Type: ${notification.subject.type}
- Updated: ${notification.updated_at}

Respond ONLY with a JSON object matching this schema:
{
  "type": "object",
  "properties": {
    "important": { "type": "boolean", "description": "True if requires urgent attention or action, false otherwise." },
    "reason": { "type": "string", "description": "Brief justification for the importance classification (1-2 sentences)." }
  },
  "required": ["important", "reason"]
}`;

  const outputSchema = {
    type: "object",
    properties: {
      important: { type: "boolean" },
      reason: { type: "string" },
    },
    required: ["important", "reason"],
  };

  try {
    logger.debug(
      { agentId: runtime.agentId, promptLength: prompt.length },
      "[PingPal GitHub] Calling LLM for analysis...",
    );

    const rawResponse = await runtime.useModel(ModelType.OBJECT_SMALL, {
      prompt: prompt,
      schema: outputSchema,
    });

    if (
      typeof rawResponse === "object" &&
      rawResponse !== null &&
      typeof (rawResponse as any).important === "boolean" &&
      typeof (rawResponse as any).reason === "string"
    ) {
      return rawResponse as { important: boolean; reason: string };
    } else if (typeof rawResponse === "string") {
      const parsed = parseJSONObjectFromText(rawResponse);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as any).important === "boolean" &&
        typeof (parsed as any).reason === "string"
      ) {
        return parsed as { important: boolean; reason: string };
      }
    }

    throw new Error(
      `Invalid LLM response format: ${JSON.stringify(rawResponse)}`,
    );
  } catch (llmError) {
    logger.error(
      {
        error: llmError instanceof Error ? {
          name: llmError.name,
          message: llmError.message,
          stack: llmError.stack
        } : String(llmError),
        agentId: runtime.agentId,
        modelType: ModelType.OBJECT_SMALL,
        promptLength: prompt.length
      },
      "[PingPal GitHub] LLM analysis failed.",
    );
    return { important: false, reason: "LLM analysis failed." };
  }
}

async function logProcessedNotification(
  runtime: IAgentRuntime,
  notification: GitHubNotification,
  analysisResult: { important: boolean; reason: string } | null,
  providedRoomId?: UUID, // Optional room ID from caller
): Promise<void> {
  const notifiedStatus = analysisResult?.important || false;

  // Use agent-specific internal room ID (like email plugin pattern)
  // This ensures proper FK relationships and avoids constraint errors
  const internalRoomId = getInternalRoomIdForAgent(runtime.agentId);

  const processedMemory: Omit<Memory, "id" | "updatedAt"> = {
    entityId: runtime.agentId,
    roomId: internalRoomId, // Always use internal room ID for consistency
    agentId: runtime.agentId,
    createdAt: Date.now(),
    content: {
      text: `[PingPal GitHub] Processed notification ${notification.id}. Important: ${notifiedStatus}. Reason: ${analysisResult?.reason}`,
    },
    metadata: {
      type: "pingpal_github_processed",
      githubNotificationId: notification.id,
      githubUrl: notification.url,
      notifiedViaTelegram: notifiedStatus,
      analysisResult: analysisResult?.reason,
      sourceContext: {
        repository: notification.repository.full_name,
        notificationType: notification.reason,
        subjectTitle: notification.subject.title,
        subjectType: notification.subject.type,
      },
    } as MemoryMetadata & Record<string, unknown>,
  };

  try {
    await runtime.createMemory(
      processedMemory as Memory,
      "pingpal_github_processed",
    );
    logger.info(
      {
        notificationId: notification.id,
        notified: notifiedStatus,
        agentId: runtime.agentId,
        roomId: internalRoomId,
      },
      "[PingPal GitHub] Logged processed GitHub notification successfully to database.",
    );
  } catch (dbError) {
    logger.error(
      {
        error: dbError,
        notificationId: notification.id,
        agentId: runtime.agentId,
        roomId: internalRoomId,
      },
      "[PingPal GitHub] CRITICAL: Failed to log processed GitHub notification to database. This will cause duplicates on restart!",
    );
    // This is critical - we need database persistence for restart-resistant deduplication
    throw new Error(`Database logging failed: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
  }
}
