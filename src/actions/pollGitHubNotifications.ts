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
import { GitHubService } from "../services/githubService";

export const pollGitHubNotificationsAction: Action = {
  name: "POLL_GITHUB_NOTIFICATIONS",
  similes: [
    "poll github",
    "check github notifications",
    "fetch github updates",
  ],
  description:
    "Polls GitHub notifications and triggers analysis for important ones",
  examples: [] as ActionExample[][],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<boolean> => {
    // This action is triggered internally, not by user messages
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      logger.info("[PingPal GitHub] Starting GitHub notifications polling...");

      const accessToken = process.env.GITHUB_ACCESS_TOKEN;
      if (!accessToken) {
        logger.error("[PingPal GitHub] GITHUB_ACCESS_TOKEN not configured");
        return {
          success: false,
          error: new Error("GITHUB_ACCESS_TOKEN not configured"),
        };
      }

      const targetUsername = process.env.PINGPAL_TARGET_GITHUB_USERNAME;
      if (!targetUsername) {
        logger.error(
          "[PingPal GitHub] PINGPAL_TARGET_GITHUB_USERNAME not configured"
        );
        return {
          success: false,
          error: new Error("PINGPAL_TARGET_GITHUB_USERNAME not configured"),
        };
      }

      const githubService = new GitHubService(accessToken);
      const notifications = await githubService.getNotifications();

      // Filter for relevant notification types
      const relevantNotifications = notifications.filter((notification) =>
        ["mention", "review_requested", "assign", "author"].includes(
          notification.reason
        )
      );

      logger.info(
        {
          total: notifications.length,
          relevant: relevantNotifications.length,
        },
        "[PingPal GitHub] Filtered GitHub notifications"
      );

      // Log each relevant notification for now
      // TODO: In Task 7, these will be processed by ANALYZE_GITHUB_NOTIFICATION action
      for (const notification of relevantNotifications) {
        logger.info(
          {
            id: notification.id,
            reason: notification.reason,
            repository: notification.repository.full_name,
            subject: notification.subject.title,
            type: notification.subject.type,
          },
          "[PingPal GitHub] Found relevant notification"
        );
      }

      return {
        success: true,
        text: `Polled GitHub notifications: ${notifications.length} total, ${relevantNotifications.length} relevant`,
        data: {
          totalNotifications: notifications.length,
          relevantNotifications: relevantNotifications.length,
          notifications: relevantNotifications,
        },
      };
    } catch (error) {
      logger.error(
        { error },
        "[PingPal GitHub] Failed to poll GitHub notifications"
      );
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
};
