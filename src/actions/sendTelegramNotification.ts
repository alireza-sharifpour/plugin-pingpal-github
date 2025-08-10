import type {
  Action,
  IAgentRuntime,
  Memory,
  ActionExample,
  ActionResult,
  State,
  HandlerCallback,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { GitHubNotification } from "../services/githubService";

export const sendTelegramNotificationAction: Action = {
  name: "SEND_TELEGRAM_NOTIFICATION",
  similes: ["send telegram alert", "notify via telegram"],
  description: "Sends GitHub notification alert via Telegram",
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
      const reason = (message.content as any).analysisReason as string;

      logger.info(
        {
          agentId: runtime.agentId,
          notificationId: notification.id,
          reason: reason,
        },
        "[PingPal GitHub] Preparing to send notification via Telegram.",
      );

      // Get Telegram service
      const telegramService = runtime.getService("telegram");
      if (!telegramService) {
        logger.error(
          { agentId: runtime.agentId, notificationId: notification.id },
          "[PingPal GitHub] Telegram service not found. Cannot send notification.",
        );
        return {
          success: false,
          error: new Error("Telegram service not found"),
        };
      }

      // Get target user ID
      const targetUserId = process.env.PINGPAL_TARGET_TELEGRAM_USERID;
      if (!targetUserId) {
        logger.error(
          { agentId: runtime.agentId, notificationId: notification.id },
          "[PingPal GitHub] PINGPAL_TARGET_TELEGRAM_USERID not configured. Cannot send notification.",
        );
        return {
          success: false,
          error: new Error("PINGPAL_TARGET_TELEGRAM_USERID not configured"),
        };
      }

      // Format notification message
      const notificationText = formatGitHubNotification(notification, reason);

      // Send via Telegram
      if (
        telegramService &&
        (telegramService as any).bot?.telegram?.sendMessage
      ) {
        await (telegramService as any).bot.telegram.sendMessage(
          targetUserId,
          notificationText,
          { parse_mode: "MarkdownV2" },
        );

        logger.info(
          {
            agentId: runtime.agentId,
            targetUserId: targetUserId,
            notificationId: notification.id,
          },
          "[PingPal GitHub] Telegram notification sent successfully.",
        );

        return {
          success: true,
          text: `Telegram notification sent for GitHub notification ${notification.id}`,
          data: {
            notificationId: notification.id,
            telegramUserId: targetUserId,
            message: notificationText,
          },
        };
      } else {
        logger.error(
          { agentId: runtime.agentId },
          "[PingPal GitHub] Could not find nested bot.telegram.sendMessage function on Telegram service instance.",
        );
        return {
          success: false,
          error: new Error(
            "Telegram service bot.telegram.sendMessage not available",
          ),
        };
      }
    } catch (sendError) {
      logger.error(
        {
          error:
            sendError instanceof Error
              ? {
                  message: sendError.message,
                  stack: sendError.stack,
                  name: sendError.name,
                }
              : sendError,
          agentId: runtime.agentId,
          notificationId: (message.content as any)?.githubNotification?.id,
        },
        "[PingPal GitHub] Failed to send Telegram notification.",
      );
      return {
        success: false,
        error:
          sendError instanceof Error ? sendError : new Error(String(sendError)),
      };
    }
  },
};

function escapeMarkdownV2(text: string): string {
  // Escape characters: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function formatGitHubNotification(
  notification: GitHubNotification,
  reason: string,
): string {
  const repoName = escapeMarkdownV2(notification.repository.full_name);
  const subject = escapeMarkdownV2(notification.subject.title);
  const notificationType = escapeMarkdownV2(notification.reason);
  const escapedReason = escapeMarkdownV2(reason);

  // Create appropriate link based on subject type and URL
  let itemLink = notification.repository.html_url;
  if (notification.subject.url) {
    // Convert API URL to web URL
    itemLink = notification.subject.url
      .replace("https://api.github.com/repos/", "https://github.com/")
      .replace("/pulls/", "/pull/")
      .replace("/issues/", "/issue/");
  }

  const notificationText = `*🔔 PingPal Alert: Important GitHub Notification*

*Repository:* ${repoName}
*Type:* ${notificationType}
*Subject:* ${subject}

*Reason:* ${escapedReason}

[View on GitHub](${itemLink})`;

  return notificationText;
}
