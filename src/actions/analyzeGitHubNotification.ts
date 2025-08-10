import type {
  Action,
  IAgentRuntime,
  Memory,
  ActionExample,
  MemoryMetadata,
  ActionResult,
  State,
  HandlerCallback,
} from "@elizaos/core";
import { logger, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import { GitHubNotification } from "../services/githubService";

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
          threadId: notification.thread.id,
          reason: notification.reason,
          repository: notification.repository.full_name,
        },
        "[PingPal GitHub] Analyzing GitHub notification...",
      );

      // Check for duplicates
      try {
        const existing = await runtime.getMemories({
          tableName: "pingpal_github_processed",
          agentId: runtime.agentId,
          count: 100, // Check last 100 processed notifications
        });

        const isDuplicate = existing.some((mem) => {
          const metadata = mem.metadata as Record<string, unknown>;
          return (
            metadata?.githubNotificationId === notification.id &&
            metadata?.githubThreadId === notification.thread.id
          );
        });

        if (isDuplicate) {
          logger.info(
            { notificationId: notification.id },
            "[PingPal GitHub] Duplicate notification detected. Skipping.",
          );
          return {
            success: true,
            text: `Skipped duplicate notification ${notification.id}`,
            data: { skipped: true, reason: "duplicate" },
          };
        }
      } catch (dbError) {
        logger.error(
          { error: dbError, notificationId: notification.id },
          "[PingPal GitHub] Error checking for duplicate notifications.",
        );
        return {
          success: false,
          error:
            dbError instanceof Error ? dbError : new Error(String(dbError)),
        };
      }

      // Perform LLM analysis
      const targetUsername = process.env.PINGPAL_TARGET_GITHUB_USERNAME;
      const analysisResult = await performImportanceAnalysis(
        runtime,
        notification,
        targetUsername || "",
      );

      // Log processed notification
      await logProcessedNotification(runtime, notification, analysisResult);

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
        { error },
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
      { error: llmError, agentId: runtime.agentId },
      "[PingPal GitHub] LLM analysis failed.",
    );
    return { important: false, reason: "LLM analysis failed." };
  }
}

async function logProcessedNotification(
  runtime: IAgentRuntime,
  notification: GitHubNotification,
  analysisResult: { important: boolean; reason: string } | null,
): Promise<void> {
  const notifiedStatus = analysisResult?.important || false;

  const processedMemory: Omit<Memory, "id" | "updatedAt"> = {
    entityId: runtime.agentId,
    roomId: crypto.randomUUID(),
    agentId: runtime.agentId,
    createdAt: Date.now(),
    content: {
      text: `[PingPal GitHub] Processed notification ${notification.id}. Important: ${notifiedStatus}. Reason: ${analysisResult?.reason}`,
    },
    metadata: {
      type: "pingpal_github_processed",
      githubNotificationId: notification.id,
      githubThreadId: notification.thread.id,
      notifiedViaTelegram: notifiedStatus,
      analysisResult: analysisResult?.reason,
      sourceContext: {
        repository: notification.repository.full_name,
        notificationType: notification.reason,
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
      },
      "[PingPal GitHub] Logged processed GitHub notification successfully.",
    );
  } catch (dbError) {
    logger.error(
      {
        error: dbError,
        notificationId: notification.id,
        agentId: runtime.agentId,
      },
      "[PingPal GitHub] Failed to log processed GitHub notification.",
    );
  }
}
